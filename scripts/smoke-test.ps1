# Smoke test for the running app, from a Windows PC.
# Read-only: it never creates, changes or deletes guest data (it only logs in
# and out, which adds and removes a session).
#
# Usage (PowerShell 5.1 or 7):
#   powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1 -BaseUrl http://192.168.2.40:8088
#   powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1 -AdminPassword 'your password'
# Without -AdminPassword the logged-in checks print SKIP.
# Exit code 0 = all checks passed (SKIP is not a failure), 1 = a check failed.

param(
    [string]$BaseUrl = 'http://192.168.2.40:8088',
    [string]$AdminPassword = ''
)

$BaseUrl = $BaseUrl.TrimEnd('/')
$script:Fails = 0

# Returns an object with StatusCode and Content. Does not throw on 4xx/5xx.
function Get-Url([string]$Path) {
    try {
        $r = Invoke-WebRequest -Uri ($BaseUrl + $Path) -UseBasicParsing -TimeoutSec 10
        return [pscustomobject]@{ StatusCode = [int]$r.StatusCode; Content = [string]$r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($resp -ne $null) {
            return [pscustomobject]@{ StatusCode = [int]$resp.StatusCode; Content = '' }
        }
        return [pscustomobject]@{ StatusCode = 0; Content = $_.Exception.Message }
    }
}

# Lower-level request used for the admin checks: does NOT follow redirects
# (so we can see the 303 and its Location), keeps cookies in $Cookies, and
# behaves the same in PowerShell 5.1 and 7. $Form is a hashtable of fields
# sent as a normal HTML form post; without it the request is a GET.
function Invoke-Http([string]$Path, $Cookies, [hashtable]$Form = $null) {
    $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($BaseUrl + $Path)
    $req.AllowAutoRedirect = $false
    $req.Timeout = 10000
    if ($Cookies -ne $null) { $req.CookieContainer = $Cookies }
    if ($Form -ne $null) {
        $pairs = foreach ($k in $Form.Keys) {
            [System.Uri]::EscapeDataString([string]$k) + '=' + [System.Uri]::EscapeDataString([string]$Form[$k])
        }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(($pairs -join '&'))
        $req.Method = 'POST'
        $req.ContentType = 'application/x-www-form-urlencoded'
        $req.ContentLength = $bytes.Length
        $stream = $req.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
    }
    $resp = $null
    try {
        $resp = $req.GetResponse()
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response   # 4xx/5xx still have a response
        if ($resp -eq $null) {
            return [pscustomobject]@{ StatusCode = 0; Location = ''; Content = $_.Exception.Message }
        }
    }
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $content = $reader.ReadToEnd()
    $reader.Close()
    $result = [pscustomobject]@{
        StatusCode = [int]$resp.StatusCode
        Location   = [string]$resp.Headers['Location']
        Content    = $content
    }
    $resp.Close()
    return $result
}

function Test-Check([string]$Name, [bool]$Ok, [string]$Detail) {
    if ($Ok) {
        Write-Host "PASS  $Name" -ForegroundColor Green
    } else {
        Write-Host "FAIL  $Name  ($Detail)" -ForegroundColor Red
        $script:Fails++
    }
}

function Skip-Check([string]$Name, [string]$Reason) {
    Write-Host "SKIP  $Name  ($Reason)" -ForegroundColor Yellow
}

function Get-Visits([string]$Html) {
    if ($Html -match '<span id="visits">(\d+)</span>') { return [int]$Matches[1] }
    return -1
}

# First hidden _csrf value in a page, or '' if there is none.
function Get-CsrfToken([string]$Html) {
    if ($Html -match 'name="_csrf" value="([^"]*)"') { return $Matches[1] }
    return ''
}

# POST without following redirects can be slow in .NET Framework because of
# "Expect: 100-continue"; switch that off.
[System.Net.ServicePointManager]::Expect100Continue = $false

Write-Host "Smoke test against $BaseUrl"

# 1. /health -> 200 and status ok
$r = Get-Url '/health'
$statusOk = $false
if ($r.StatusCode -eq 200) {
    try { $statusOk = ((ConvertFrom-Json $r.Content).status -eq 'ok') } catch { $statusOk = $false }
}
Test-Check '/health returns 200 and status ok' $statusOk "HTTP $($r.StatusCode), body: $($r.Content)"

# 2. / -> 200
$r = Get-Url '/'
$first = Get-Visits $r.Content
Test-Check '/ returns 200' ($r.StatusCode -eq 200) "HTTP $($r.StatusCode)"

# 3. counter increases between two loads of /
$r = Get-Url '/'
$second = Get-Visits $r.Content
Test-Check 'visit counter increases' (($first -ge 0) -and ($second -gt $first)) "first=$first second=$second"

# 4. unknown path -> 404
$r = Get-Url '/no-such-page'
Test-Check 'unknown path returns 404' ($r.StatusCode -eq 404) "HTTP $($r.StatusCode)"

# 4b. the stylesheet and the import script are served
foreach ($p in @('/static/style.css', '/static/import.js')) {
    $r = Get-Url $p
    Test-Check "$p returns 200" ($r.StatusCode -eq 200) "HTTP $($r.StatusCode)"
}

# 5. /admin/guests without logging in -> redirect to the login page
$r = Invoke-Http '/admin/guests' $null
$ok = (($r.StatusCode -eq 302) -or ($r.StatusCode -eq 303)) -and $r.Location.EndsWith('/admin/login')
Test-Check '/admin/guests without login redirects to /admin/login' $ok "HTTP $($r.StatusCode), Location: $($r.Location)"

# 6-8. Logged-in checks (need -AdminPassword)
$L6 = 'admin login'
$L7 = '/admin/guests returns 200 when logged in'
$L8 = 'POST without CSRF token is rejected (403)'
if ($AdminPassword -eq '') {
    foreach ($n in @($L6, $L7, $L8)) { Skip-Check $n 'no -AdminPassword given' }
} else {
    $jar = New-Object System.Net.CookieContainer

    # 6. Log in: load the form (sets the login cookie and hidden token), post it.
    $r = Invoke-Http '/admin/login' $jar
    $token = Get-CsrfToken $r.Content
    $r = Invoke-Http '/admin/login' $jar @{ '_csrf' = $token; 'password' = $AdminPassword }
    $loggedIn = ($r.StatusCode -eq 303) -and $r.Location.EndsWith('/admin')
    Test-Check $L6 $loggedIn "HTTP $($r.StatusCode) (401 = wrong password, 403 = login disabled, 429 = locked out)"

    if ($loggedIn) {
        # 7. The guest list loads.
        $r = Invoke-Http '/admin/guests' $jar
        Test-Check $L7 (($r.StatusCode -eq 200) -and ($r.Content -match 'id="guest-count"')) "HTTP $($r.StatusCode)"
        $sessionToken = Get-CsrfToken $r.Content

        # 8. A POST with a valid session but no CSRF token must be refused.
        # (No guest name in the body either, so even a broken check could
        # not create a guest.)
        $r = Invoke-Http '/admin/guests/new' $jar @{ 'smoke_test' = '1' }
        Test-Check $L8 ($r.StatusCode -eq 403) "HTTP $($r.StatusCode)"

        # Log out again (ends the session; not a check).
        $null = Invoke-Http '/admin/logout' $jar @{ '_csrf' = $sessionToken }
    } else {
        Skip-Check $L7 'login failed'
        Skip-Check $L8 'login failed'
    }
}

Write-Host ''
if ($script:Fails -eq 0) {
    Write-Host "All checks passed (visits now $second)."
    exit 0
}
Write-Host "$($script:Fails) check(s) failed."
exit 1
