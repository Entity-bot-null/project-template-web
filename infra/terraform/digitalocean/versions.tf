# Terraform and the providers, pinned. .terraform.lock.hcl (committed) holds
# the providers' checksums for linux_amd64, darwin_amd64, darwin_arm64 and
# windows_amd64; `pnpm iac:check` refuses a lock file that does not match.
#
# Dependabot (the terraform entry of .github/dependabot.yml) proposes a
# provider release once it is a week old, version and checksums together.
# By hand: change a version here, then
#   terraform init -upgrade -backend=false
#   terraform providers lock -platform=linux_amd64 -platform=darwin_amd64 \
#     -platform=darwin_arm64 -platform=windows_amd64
# Terraform itself moves with the terraform image of
# scripts/tool-images/Dockerfile: keep required_version on its minor version.
terraform {
  required_version = "~> 1.17.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "2.106.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }

  # The state stays in this directory (terraform.tfstate.d/<workspace>/, never
  # committed: it holds the database passwords). For a team, keep it in
  # DigitalOcean Spaces instead: uncomment the line below, then
  # `terraform init -backend-config=backend.hcl -migrate-state`
  # (backend.hcl.example; docs/deploy-vps.md#state).
  #
  # backend "s3" {}
}

# The API token comes from the DIGITALOCEAN_TOKEN environment variable only:
# never a variable, a file in this directory or the state.
provider "digitalocean" {}
