#!/bin/sh
# Smoke test for the running app. Read-only: it never creates, changes or
# deletes guest data (it only logs in and out, which adds/removes a session).
#
# Usage:  sh scripts/smoke-test.sh [base-url] [admin-password]
#         ADMIN_PASSWORD=... sh scripts/smoke-test.sh [base-url]
#         (default base-url: http://localhost:8088)
# Without a password the logged-in checks print SKIP.
# POSIX sh; uses curl if available, otherwise wget (busybox wget is fine,
# but the logged-in checks need curl and print SKIP with wget).
# Exit code 0 = all checks passed (SKIP is not a failure), 1 = a check failed.

set -u

BASE=${1:-http://localhost:8088}
BASE=${BASE%/}                        # strip a trailing slash
PASSWORD=${2:-${ADMIN_PASSWORD:-}}
TMP=$(mktemp)
HDR=$(mktemp)
JAR=$(mktemp)
trap 'rm -f "$TMP" "$HDR" "$JAR"' EXIT
FAILS=0

# fetch PATH -> prints HTTP status code, response body goes to $TMP
# fetch_first PATH -> prints "STATUS LOCATION" of the first response
#                     (does not follow redirects)
if command -v curl >/dev/null 2>&1; then
  HAVE_CURL=1
  fetch() {
    : > "$TMP"
    # curl prints 000 itself when it cannot connect
    curl -s -o "$TMP" -w '%{http_code}' --max-time 10 "$BASE$1"
  }
  fetch_first() {
    : > "$HDR"
    code=$(curl -s -o /dev/null -D "$HDR" -w '%{http_code}' --max-time 10 "$BASE$1")
    location=$(sed -n 's/^[Ll]ocation: *//p' "$HDR" | tr -d '\r' | head -n 1)
    echo "$code $location"
  }
elif command -v wget >/dev/null 2>&1; then
  HAVE_CURL=0
  fetch() {
    : > "$TMP"
    # -S prints response headers to stderr; wget exits non-zero on 404,
    # so the status code is taken from the "HTTP/1.1 NNN" header line.
    code=$(wget -S -q -T 10 -O "$TMP" "$BASE$1" 2>&1 | awk '/HTTP\//{c=$2} END{print c}')
    echo "${code:-000}"
  }
  fetch_first() {
    # wget follows redirects; the FIRST status line and Location header
    # belong to the original response.
    wget -S -q -T 10 -O /dev/null "$BASE$1" 2>&1 |
      awk '/HTTP\//{ if (c == "") c = $2 } tolower($1) == "location:" { if (l == "") l = $2 } END { print (c == "" ? "000" : c) " " l }'
  }
else
  echo "ERROR: neither curl nor wget found"; exit 2
fi

check() {  # check NAME RESULT DETAIL   (RESULT: 0 = pass, anything else = fail)
  if [ "$2" -eq 0 ]; then
    echo "PASS  $1"
  else
    echo "FAIL  $1  ($3)"
    FAILS=$((FAILS + 1))
  fi
}
skip() { echo "SKIP  $1  ($2)"; }

# Extract the number from <span id="visits">N</span> in $TMP
visits() { sed -n 's/.*<span id="visits">\([0-9]*\)<\/span>.*/\1/p' "$TMP"; }
# Extract the first hidden _csrf value from the page in $TMP
csrf_token() { sed -n 's/.*name="_csrf" value="\([^"]*\)".*/\1/p' "$TMP" | head -n 1; }

echo "Smoke test against $BASE"

# 1. /health -> 200 and "status":"ok"
code=$(fetch /health)
body=$(cat "$TMP")
if [ "$code" = 200 ] && echo "$body" | grep -q '"status":"ok"'; then r=0; else r=1; fi
check "/health returns 200 and status ok" "$r" "HTTP $code, body: $body"

# 2. /status -> 200
code=$(fetch /status)
first=$(visits)
if [ "$code" = 200 ]; then r=0; else r=1; fi
check "/status returns 200" "$r" "HTTP $code"

# 3. counter increases between two loads of /status
code=$(fetch /status)
second=$(visits)
if [ -n "$first" ] && [ -n "$second" ] && [ "$second" -gt "$first" ]; then r=0; else r=1; fi
check "visit counter increases" "$r" "first=${first:-none} second=${second:-none}"

# 4. unknown path -> 404
code=$(fetch /no-such-page)
if [ "$code" = 404 ]; then r=0; else r=1; fi
check "unknown path returns 404" "$r" "HTTP $code"

# 4b. the stylesheet and the import script are served
for p in /static/style.css /static/import.js; do
  code=$(fetch "$p")
  if [ "$code" = 200 ]; then r=0; else r=1; fi
  check "$p returns 200" "$r" "HTTP $code"
done

# 4c. the front page (save-the-date card) answers: 200 when published, 404 when not (never a 500)
for p in / /save-the-date; do
  code=$(fetch "$p")
  if [ "$code" = 200 ] || [ "$code" = 404 ]; then r=0; else r=1; fi
  check "$p returns 200 or 404" "$r" "HTTP $code"
done

# 5. /admin/guests without logging in -> redirect to the login page
first_response=$(fetch_first /admin/guests)   # "STATUS LOCATION"
code=${first_response%% *}
location=${first_response#* }
case "$code $location" in
  30[23]\ */admin/login) r=0 ;;
  *) r=1 ;;
esac
check "/admin/guests without login redirects to /admin/login" "$r" "HTTP $code, Location: ${location:-none}"

# 6-8. Logged-in checks (need a password and curl)
L6="admin login"
L7="/admin/guests returns 200 when logged in"
L8="POST without CSRF token is rejected (403)"
if [ -z "$PASSWORD" ]; then
  for n in "$L6" "$L7" "$L8"; do skip "$n" "no admin password given"; done
elif [ "$HAVE_CURL" != 1 ]; then
  for n in "$L6" "$L7" "$L8"; do skip "$n" "needs curl"; done
else
  # 6. Log in: load the form (sets the login cookie + hidden token), post it.
  : > "$JAR"
  curl -s -o "$TMP" -c "$JAR" -b "$JAR" --max-time 10 "$BASE/admin/login"
  token=$(csrf_token)
  code=$(curl -s -o /dev/null -D "$HDR" -w '%{http_code}' -c "$JAR" -b "$JAR" --max-time 10 \
    --data-urlencode "_csrf=$token" --data-urlencode "password=$PASSWORD" "$BASE/admin/login")
  location=$(sed -n 's/^[Ll]ocation: *//p' "$HDR" | tr -d '\r' | head -n 1)
  case "$code $location" in
    303\ */admin) logged_in=1; r=0 ;;
    *) logged_in=0; r=1 ;;
  esac
  check "$L6" "$r" "HTTP $code (401 = wrong password, 403 = login disabled, 429 = locked out)"

  if [ "$logged_in" = 1 ]; then
    # 7. The guest list loads.
    code=$(curl -s -o "$TMP" -w '%{http_code}' -b "$JAR" --max-time 10 "$BASE/admin/guests")
    if [ "$code" = 200 ] && grep -q 'id="guest-count"' "$TMP"; then r=0; else r=1; fi
    check "$L7" "$r" "HTTP $code"
    session_token=$(csrf_token)

    # 8. A POST with a valid session but no CSRF token must be refused.
    # (The body has no guest name either, so even a broken check could not
    # create a guest.)
    code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" --max-time 10 \
      --data 'smoke_test=1' "$BASE/admin/guests/new")
    if [ "$code" = 403 ]; then r=0; else r=1; fi
    check "$L8" "$r" "HTTP $code"

    # Log out again (ends the session; not a check).
    curl -s -o /dev/null -b "$JAR" --max-time 10 --data-urlencode "_csrf=$session_token" "$BASE/admin/logout"
  else
    skip "$L7" "login failed"
    skip "$L8" "login failed"
  fi
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "All checks passed (visits now ${second:-?})."
  exit 0
fi
echo "$FAILS check(s) failed."
exit 1
