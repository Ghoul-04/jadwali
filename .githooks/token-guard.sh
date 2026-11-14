# Shared helper for the git hooks. Reads BOT_TOKEN from the repo's .env without printing it.
read_token() {
  root=$(git rev-parse --show-toplevel)
  [ -f "$root/.env" ] || return 0
  sed -n 's/^BOT_TOKEN=//p' "$root/.env" | tr -d '\r\n" '
}
