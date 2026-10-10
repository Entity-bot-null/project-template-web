# What the manual steps that remain need (docs/deploy-vps.md#provision-with-terraform-digitalocean).
# The connection strings carry passwords: they are sensitive, shown only with
# `terraform output -raw <name>`, and never in a plan or apply log.

output "server_ipv4" {
  description = "The server's public address (reserved): the A record of domain points here."
  value       = digitalocean_reserved_ip.app.ip_address
}

output "droplet_id" {
  description = "The server's Droplet ID, to find it in the control panel or with doctl."
  value       = digitalocean_droplet.app.id
}

output "ssh_admin" {
  description = "SSH destination of the administrator account (ssh <this>)."
  value       = "${var.admin_username}@${digitalocean_reserved_ip.app.ip_address}"
}

output "dns_record" {
  description = "The A record the domain needs; created by Terraform only with manage_dns."
  value = {
    name    = var.domain
    type    = "A"
    value   = digitalocean_reserved_ip.app.ip_address
    managed = var.manage_dns
  }
}

output "github_environment_variables" {
  description = "The variables of this environment in GitHub (Settings, Environments): docs/deploy-vps.md#7-github-settings."
  value = {
    DEPLOY_HOST = var.domain
    PUBLIC_URL  = "https://${var.domain}"
  }
}

output "database_host" {
  description = "The database's private host name, reachable from the server only."
  value       = digitalocean_database_cluster.app.private_host
}

output "database_port" {
  description = "The database's port."
  value       = digitalocean_database_cluster.app.port
}

output "database_admin_url" {
  description = "The cluster administrator (doadmin), for pnpm iac:database and break-glass work from the server. Never in an env file of the application."
  value       = digitalocean_database_cluster.app.private_uri
  sensitive   = true
}

output "database_migrator_url" {
  description = "DATABASE_URL of /srv/app/migrate.env: the app_migrator role, over the private network, TLS required."
  value       = local.database_url.app_migrator
  sensitive   = true
}

output "database_runtime_url" {
  description = "DATABASE_URL of /srv/app/api.env: the app_runtime role, over the private network, TLS required."
  value       = local.database_url.app_runtime
  sensitive   = true
}
