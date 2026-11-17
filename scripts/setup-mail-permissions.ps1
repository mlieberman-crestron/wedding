# One-time Exchange Online setup: lets the "Wedding app mailer" app registration
# send mail as the weddings@ shared mailbox and NO other mailbox
# (Exchange "RBAC for Applications"). Safe to run again; existing pieces are kept.
#
# Usage (from the repo folder, in PowerShell):
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-mail-permissions.ps1
# You sign in once as an Exchange admin. Do NOT add Mail.Send under the app's
# "API permissions" in Entra: that would allow sending as every mailbox.

param(
    [string]$AppId     = '575365f7-8630-4dab-95ad-72674212cb7d',  # Application (client) ID
    [string]$ObjectId  = 'a068143d-913d-4086-84aa-452811e4f933',  # Enterprise application Object ID (NOT the App registrations one)
    [string]$Mailbox   = 'weddings@evmail.us',
    [string]$Admin     = 'rmlieb@evmail.us',
    [string]$OtherMailbox = 'rmlieb@evmail.us'                    # must come back NOT in scope
)

$ErrorActionPreference = 'Stop'
$ScopeName = 'Wedding mailbox only'
$DisplayName = 'Wedding app mailer'

if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
    Write-Host 'Installing the ExchangeOnlineManagement module (Microsoft, PowerShell Gallery)...'
    Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber
}
Import-Module ExchangeOnlineManagement

Write-Host "Signing in to Exchange Online as $Admin (a browser window may open)..."
Connect-ExchangeOnline -UserPrincipalName $Admin -ShowBanner:$false

try {
    # 0. Small tenants start "dehydrated" and must be enabled once before custom
    #    management scopes can be created. One-time, permanent, harmless.
    if ((Get-OrganizationConfig).IsDehydrated) {
        Write-Host '[0/3] Enabling organization customization (one-time; can take a few minutes)...'
        Enable-OrganizationCustomization
    }

    # 1. Service principal pointer in Exchange
    $sp = Get-ServicePrincipal | Where-Object { $_.AppId -eq $AppId }
    if ($sp) {
        Write-Host "[1/3] Service principal already exists: $($sp.DisplayName)"
        if ($sp.ObjectId -ne $ObjectId) {
            Write-Warning "Existing service principal has ObjectId $($sp.ObjectId), expected $ObjectId."
        }
    } else {
        New-ServicePrincipal -AppId $AppId -ObjectId $ObjectId -DisplayName $DisplayName | Out-Null
        Write-Host "[1/3] Service principal created."
    }

    # 2. Scope that matches only the weddings mailbox
    if (Get-ManagementScope | Where-Object { $_.Name -eq $ScopeName }) {
        Write-Host "[2/3] Management scope '$ScopeName' already exists."
    } else {
        New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter "PrimarySmtpAddress -eq '$Mailbox'" | Out-Null
        Write-Host "[2/3] Management scope '$ScopeName' created."
    }

    # 3. Grant Mail.Send limited to that scope
    $existing = Get-ManagementRoleAssignment -Role 'Application Mail.Send' |
        Where-Object { $_.CustomResourceScope -eq $ScopeName }
    if ($existing) {
        Write-Host "[3/3] Mail.Send assignment already exists."
    } else {
        New-ManagementRoleAssignment -App $AppId -Role 'Application Mail.Send' -CustomResourceScope $ScopeName | Out-Null
        Write-Host "[3/3] Mail.Send granted for '$ScopeName'."
    }

    Write-Host ''
    Write-Host "Check: $Mailbox (expect InScope = True)"
    Test-ServicePrincipalAuthorization -Identity $AppId -Resource $Mailbox |
        Format-Table RoleName, GrantedPermissions, AllowedResourceScope, InScope -AutoSize
    Write-Host "Check: $OtherMailbox (expect InScope = False)"
    Test-ServicePrincipalAuthorization -Identity $AppId -Resource $OtherMailbox |
        Format-Table RoleName, GrantedPermissions, AllowedResourceScope, InScope -AutoSize
    Write-Host 'Done. Changes can take up to 2 hours to apply everywhere (usually minutes).'
}
finally {
    Disconnect-ExchangeOnline -Confirm:$false | Out-Null
}
