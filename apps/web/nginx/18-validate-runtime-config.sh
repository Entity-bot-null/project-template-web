#!/bin/sh
# Runs before nginx renders its templates (/docker-entrypoint.d, in order:
# after 15-local-resolvers.envsh, before 20-envsubst-on-templates.sh): the
# runtime settings end up inside JSON and an nginx config, so each one must
# have the shape its consumer expects. A bad value stops the container with
# the variable's name, never its value (docs/environment.md#web-variables).
set -eu

fail() {
  echo "Environment variable $1 is invalid: $2" >&2
  exit 1
}

newline='
'
carriage_return=$(printf '\r')

# One line, and none of the characters that end or escape a JSON string or
# the single-quoted nginx string around it, or that nginx would read as a
# variable: checked first, since grep matches line by line, so a second line
# would ride in on a valid first one.
matches() {
  case "$1" in
    *"$newline"* | *"$carriage_return"* | *\"* | *\'* | *\\* | *\$*) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq "$2"
}

matches "${APP_ENVIRONMENT:-}" '^[a-z][a-z0-9-]{0,31}$' ||
  fail APP_ENVIRONMENT 'lowercase letters, digits and "-", starting with a letter'
matches "${APP_RELEASE:-}" '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$' ||
  fail APP_RELEASE 'letters, digits, ".", "_", "+", "-"'
if [ -n "${WEB_SENTRY_DSN:-}" ]; then
  matches "$WEB_SENTRY_DSN" '^https://[A-Za-z0-9]+@[A-Za-z0-9.-]+(:[0-9]+)?/([A-Za-z0-9._-]+/)*[0-9]+$' ||
    fail WEB_SENTRY_DSN 'must be an https Sentry DSN: https://<public key>@<host>/<project id>'
fi
matches "${WEB_SENTRY_SAMPLE_RATE:-}" '^(0(\.[0-9]+)?|1(\.0+)?)$' ||
  fail WEB_SENTRY_SAMPLE_RATE 'a number from 0 to 1'
matches "${WEB_VITALS_SAMPLE_RATE:-}" '^(0(\.[0-9]+)?|1(\.0+)?)$' ||
  fail WEB_VITALS_SAMPLE_RATE 'a number from 0 to 1'
# From /etc/resolv.conf (15-local-resolvers.envsh): nginx looks API_UPSTREAM up
# again through it (default.conf.template).
[ -n "${NGINX_LOCAL_RESOLVERS:-}" ] ||
  fail NGINX_LOCAL_RESOLVERS 'no nameserver in /etc/resolv.conf to look API_UPSTREAM up with'
