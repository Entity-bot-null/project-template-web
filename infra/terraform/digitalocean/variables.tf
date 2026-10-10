# The settings of one environment (staging or production). Values go in a
# <environment>.tfvars file next to this one, never committed
# (terraform.tfvars.example). Nothing here is secret: the API token comes from
# DIGITALOCEAN_TOKEN, and the passwords are generated (database.tf).

variable "project_name" {
  description = "The product's name in lowercase, digits and dashes (acme-portal). Every resource is named <project_name>-<environment>."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,28}[a-z0-9]$", var.project_name))
    error_message = "project_name: 3 to 30 characters, lowercase letters, digits and dashes, starting with a letter."
  }
}

variable "environment" {
  description = "staging or production: one server and one database per environment, each in its own Terraform workspace (docs/deploy-vps.md#provision-with-terraform-digitalocean)."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  description = "DigitalOcean region slug of the server, its network and its database (nyc3, fra1, ams3, lon1, sgp1...)."
  type        = string
  default     = "nyc3"

  validation {
    condition     = can(regex("^[a-z]{3}[0-9]$", var.region))
    error_message = "region must be a DigitalOcean region slug such as nyc3 or fra1."
  }
}

variable "domain" {
  description = "The public host name of this environment (app.example.com): Caddy's certificate, the uptime check, DEPLOY_HOST and PUBLIC_URL."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain))
    error_message = "domain must be a lowercase host name such as app.example.com (no scheme, no path)."
  }
}

variable "manage_dns" {
  description = "Create the A record of domain in a DNS zone hosted by DigitalOcean (dns_zone). Off: create it at your DNS provider (output server_ipv4)."
  type        = bool
  default     = false
}

variable "dns_zone" {
  description = "With manage_dns: the DigitalOcean DNS zone that contains domain (example.com), already created in the account. Terraform adds one record and never touches the zone itself."
  type        = string
  default     = null

  validation {
    condition = !var.manage_dns || (
      var.dns_zone != null &&
      can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", coalesce(var.dns_zone, "-"))) &&
      (var.domain == coalesce(var.dns_zone, "-") || endswith(var.domain, ".${coalesce(var.dns_zone, "-")}"))
    )
    error_message = "With manage_dns = true, dns_zone must be the zone of domain (domain itself, or a parent of it)."
  }
}

variable "droplet_image" {
  description = "Ubuntu LTS image slug of the server. The guide's release is 24.04; cloud-init adapts to another LTS."
  type        = string
  default     = "ubuntu-24-04-x64"

  validation {
    condition     = can(regex("^ubuntu-[0-9]{2}-04-x64$", var.droplet_image)) && try(tonumber(substr(var.droplet_image, 7, 2)) % 2 == 0, false)
    error_message = "droplet_image must be an Ubuntu LTS slug (ubuntu-YY-04-x64, YY even), such as ubuntu-24-04-x64."
  }
}

variable "droplet_size" {
  description = "Droplet size slug. The guide's minimum is 2 vCPU and 4 GB of RAM (s-2vcpu-4gb)."
  type        = string
  default     = "s-2vcpu-4gb"

  validation {
    condition     = can(regex("^[a-z0-9]+(-[a-z0-9]+)+$", var.droplet_size))
    error_message = "droplet_size must be a Droplet size slug such as s-2vcpu-4gb."
  }
}

variable "droplet_backups" {
  description = "Backups of the server's disk: off, weekly (20 % of the Droplet price) or daily (30 %). The data lives in the database; they restore the server itself (its env files, the release pointers) in one step."
  type        = string
  default     = "weekly"

  validation {
    condition     = contains(["off", "weekly", "daily"], var.droplet_backups)
    error_message = "droplet_backups must be off, weekly or daily."
  }
}

variable "admin_username" {
  description = "The account for people on the server: SSH key only, sudo. root cannot log in."
  type        = string
  default     = "ops"

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]{0,31}$", var.admin_username)) && !contains(["root", "deploy", "admin", "ubuntu", "docker"], var.admin_username)
    error_message = "admin_username: a lowercase Linux user name, other than root, deploy, admin, ubuntu and docker."
  }
}

variable "admin_ssh_public_key" {
  description = "The SSH public key of admin_username (one line: ssh-ed25519 AAAA... you@laptop). Read at the first boot only: change it on the server afterwards."
  type        = string

  validation {
    condition     = can(regex("^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [^\\n\\r]*)?$", var.admin_ssh_public_key))
    error_message = "admin_ssh_public_key must be one OpenSSH public key line (ssh-ed25519, ecdsa-sha2-nistp* or ssh-rsa)."
  }
}

variable "deploy_ssh_public_key" {
  description = "The public half of the Deploy workflow's key for this environment (ssh-keygen -t ed25519 -N \"\" -C github-deploy-<environment> -f deploy_<environment>; docs/deploy-vps.md#4-the-deploy-user-and-its-ssh-key). Read at the first boot only."
  type        = string

  validation {
    condition     = can(regex("^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [^\\n\\r]*)?$", var.deploy_ssh_public_key))
    error_message = "deploy_ssh_public_key must be one OpenSSH public key line (ssh-ed25519 recommended)."
  }

  # The deploy key lives in a GitHub environment; the administrator's opens
  # sudo. One key for both would hand the workflow root.
  validation {
    condition     = try(split(" ", var.deploy_ssh_public_key)[1] != split(" ", var.admin_ssh_public_key)[1], true)
    error_message = "deploy_ssh_public_key must be a key of its own, not admin_ssh_public_key (ssh-keygen -t ed25519 -N \"\" -C github-deploy-<environment> -f deploy_<environment>)."
  }
}

variable "admin_cidrs" {
  description = "IPv4 networks allowed to reach SSH (port 22) through the cloud firewall. They must include where the Deploy workflow connects from: GitHub-hosted runners have no fixed addresses, so with them use [\"0.0.0.0/0\"], as the manual setup does (key-only SSH, no root, no passwords). Narrow it when every SSH client has a fixed address (a self-hosted runner, a VPN, a bastion)."
  type        = list(string)

  validation {
    condition     = length(var.admin_cidrs) > 0 && alltrue([for cidr in var.admin_cidrs : can(cidrnetmask(cidr))])
    error_message = "admin_cidrs must list at least one IPv4 CIDR (203.0.113.10/32, or 0.0.0.0/0). The server has no IPv6."
  }
}

variable "vpc_ip_range" {
  description = "The private network's range, inside 10.0.0.0/8, /16 to /24 (Docker uses 172.16.0.0/12 and 192.168.0.0/16 on the server). null lets DigitalOcean choose a free one."
  type        = string
  default     = null

  validation {
    condition = var.vpc_ip_range == null || (
      can(cidrnetmask(coalesce(var.vpc_ip_range, "-"))) &&
      startswith(coalesce(var.vpc_ip_range, "-"), "10.") &&
      try(tonumber(split("/", coalesce(var.vpc_ip_range, "-"))[1]) >= 16 && tonumber(split("/", coalesce(var.vpc_ip_range, "-"))[1]) <= 24, false)
    )
    error_message = "vpc_ip_range must be a CIDR inside 10.0.0.0/8 with a prefix from /16 to /24, or null."
  }
}

variable "postgres_version" {
  description = "PostgreSQL major version of the managed database (the guide requires 16 or newer; local development runs 18)."
  type        = string
  default     = "18"

  validation {
    condition     = contains(["16", "17", "18"], var.postgres_version)
    error_message = "postgres_version must be 16, 17 or 18."
  }
}

variable "database_size" {
  description = "Size slug of each database node. db-s-1vcpu-1gb serves 22 connections: the API's pool (DB_POOL_MAX, 10 by default) and a migration fit."
  type        = string
  default     = "db-s-1vcpu-1gb"

  validation {
    condition     = can(regex("^db-[a-z0-9]+(-[a-z0-9]+)+$", var.database_size))
    error_message = "database_size must be a database size slug such as db-s-1vcpu-1gb."
  }
}

variable "database_node_count" {
  description = "Database nodes: 1, or 2 to 3 for standby nodes that take over automatically when the primary fails (each costs as much as the first). DigitalOcean offers standby nodes from db-s-1vcpu-2gb up, not on the smallest plan."
  type        = number
  default     = 1

  validation {
    condition     = contains([1, 2, 3], var.database_node_count)
    error_message = "database_node_count must be 1, 2 or 3."
  }

  validation {
    condition     = var.database_node_count == 1 || var.database_size != "db-s-1vcpu-1gb"
    error_message = "Standby nodes need a database_size above db-s-1vcpu-1gb (db-s-1vcpu-2gb or larger)."
  }
}

variable "database_maintenance_window" {
  description = "When DigitalOcean may apply the database's updates (a short failover): day of the week and hour in UTC (HH:00)."
  type = object({
    day  = string
    hour = string
  })
  default = {
    day  = "sunday"
    hour = "03:00"
  }

  validation {
    condition     = contains(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], var.database_maintenance_window.day) && can(regex("^([01][0-9]|2[0-3]):00$", var.database_maintenance_window.hour))
    error_message = "database_maintenance_window: day monday to sunday (lowercase), hour HH:00 in UTC."
  }
}

variable "alert_emails" {
  description = "Who receives the alerts (CPU, memory, disk, site down, certificate expiring). DigitalOcean accepts only verified email addresses of members of the team that owns the resources."
  type        = list(string)

  validation {
    condition     = length(var.alert_emails) > 0 && alltrue([for email in var.alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))])
    error_message = "alert_emails must list at least one email address."
  }
}

variable "alert_thresholds" {
  description = "Percentages above which the monitoring alerts fire, for the server and the database (starting points of docs/alerting.md)."
  type = object({
    cpu_percent    = number
    memory_percent = number
    disk_percent   = number
  })
  default = {
    cpu_percent    = 80
    memory_percent = 85
    disk_percent   = 85
  }

  validation {
    condition     = alltrue([for value in values(var.alert_thresholds) : value > 0 && value < 100])
    error_message = "alert_thresholds: each value is a percentage between 0 and 100 (exclusive)."
  }
}

variable "tags" {
  description = "Extra DigitalOcean tags for the server and the database, on top of project_name and environment."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for tag in var.tags : can(regex("^[A-Za-z0-9:_-]{1,255}$", tag))])
    error_message = "tags: letters, digits, colons, dashes and underscores only."
  }
}
