# Synthetic values for `pnpm iac:check` (terraform test, the rendered user
# data): reserved example domains and addresses, keys whose private halves
# were never kept. Never applied.
project_name          = "acme-portal"
environment           = "staging"
region                = "fra1"
domain                = "staging.example.com"
manage_dns            = true
dns_zone              = "example.com"
admin_ssh_public_key  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICceJgSoFsOmi6WcMmpHlMEuAEdvCitSG+sYFWPadueK ops@example.test"
deploy_ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBceGNqTltI0mFsrUWTvg2Ro4mIK1Dp3kbK8eDJ/r+GR github-deploy-staging"
admin_cidrs           = ["203.0.113.10/32"]
alert_emails          = ["oncall@example.com"]
