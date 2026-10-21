# TFLint (`pnpm iac:check`, every module under infra/terraform): the bundled
# Terraform rules, all of them (naming, documented and typed variables and
# outputs, unused declarations, pinned versions, the standard module layout).
# Nothing is downloaded: the bundled ruleset ships with the pinned image of
# scripts/tool-images/Dockerfile.
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "all"
}
