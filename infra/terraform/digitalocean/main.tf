# The server of docs/deploy-vps.md on DigitalOcean: what sections 2 to 4 set
# up by hand (the server, its firewall, Docker, the deploy user and its key,
# /srv/app), plus a reserved address, the DNS record and the project that
# groups them. The database is in database.tf, the alerts in monitoring.tf.

locals {
  name = "${var.project_name}-${var.environment}"
  tags = distinct(concat([var.project_name, var.environment], var.tags))

  # The record's name inside dns_zone: "@" for the zone itself.
  dns_record_name = var.manage_dns ? (var.domain == var.dns_zone ? "@" : trimsuffix(var.domain, ".${var.dns_zone}")) : null

  # Sections 3 and 4 of the guide, run by cloud-init at the first boot.
  # Nothing secret goes in: any process on the server can read its user data
  # from the metadata service.
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    admin_username        = var.admin_username
    admin_ssh_public_key  = trimspace(var.admin_ssh_public_key)
    deploy_ssh_public_key = trimspace(var.deploy_ssh_public_key)
    docker_apt_key        = trimspace(file("${path.module}/files/docker.asc"))
  })
}

resource "digitalocean_project" "app" {
  name        = local.name
  description = "${var.project_name}, ${var.environment}: the server and database of docs/deploy-vps.md (Terraform)."
  purpose     = "Web Application"
  environment = title(var.environment)
  resources = [
    digitalocean_droplet.app.urn,
    digitalocean_reserved_ip.app.urn,
    digitalocean_database_cluster.app.urn,
  ]

  lifecycle {
    # One workspace per environment: production values applied in the
    # staging workspace would replace staging's server with production's.
    precondition {
      condition     = terraform.workspace == "default" || terraform.workspace == var.environment
      error_message = "The workspace (${terraform.workspace}) is not the environment (${var.environment}): terraform workspace select ${var.environment}."
    }
  }
}

# The private network of the server and its database: the database is
# reachable only through it, from this server only (database.tf).
resource "digitalocean_vpc" "app" {
  name        = local.name
  region      = var.region
  ip_range    = var.vpc_ip_range
  description = "${local.name}: the server and its database."
}

# A Droplet created without an account key gets a root password, emailed in
# clear; with one, it gets none. DigitalOcean installs the key for root, which
# cloud-init then refuses (disable_root), and people and the workflow log in
# with the keys of cloud-init.yaml.tftpl. The key registered is the deploy
# key, because it is the one key unique to this environment: an account
# refuses a public key it holds already, and the administrator's key is
# usually the same for staging and production.
resource "digitalocean_ssh_key" "deploy" {
  name       = "${local.name}-deploy"
  public_key = trimspace(var.deploy_ssh_public_key)
}

resource "digitalocean_droplet" "app" {
  name     = local.name
  region   = var.region
  image    = var.droplet_image
  size     = var.droplet_size
  vpc_uuid = digitalocean_vpc.app.id
  ssh_keys = [digitalocean_ssh_key.deploy.id]
  tags     = local.tags

  # IPv4 only: the compose edge network (deploy/vps/compose.yaml) has no IPv6,
  # so Docker would hand every IPv6 client to Caddy as the network's gateway
  # address, one rate-limit bucket for all of them. No IPv6 address, no AAAA
  # record, until the edge network gets IPv6 end to end.
  ipv6 = false

  # The metrics agent: CPU, memory and disk for the alerts of monitoring.tf.
  monitoring = true

  # Stop the containers cleanly before the server is destroyed or replaced.
  graceful_shutdown = true

  backups = var.droplet_backups != "off"
  dynamic "backup_policy" {
    for_each = var.droplet_backups == "off" ? [] : [var.droplet_backups]
    content {
      plan    = backup_policy.value
      weekday = backup_policy.value == "weekly" ? "SUN" : null
      hour    = 4
    }
  }

  user_data = local.user_data

  lifecycle {
    # cloud-init runs once, at the first boot, and both settings force a new
    # server, which would lose the files of /srv/app (the env files, the
    # release pointers). A change to either reaches a new server only: replace
    # it on purpose (terraform apply -replace=digitalocean_droplet.app) after
    # saving those files, or apply the change on the server by hand.
    ignore_changes = [user_data, ssh_keys]
  }
}

# A fixed public address, kept when the server is replaced, so the DNS record
# keeps pointing at it. (A new server has new SSH host keys all the same:
# update DEPLOY_KNOWN_HOSTS.)
resource "digitalocean_reserved_ip" "app" {
  region = var.region
}

resource "digitalocean_reserved_ip_assignment" "app" {
  ip_address = digitalocean_reserved_ip.app.ip_address
  droplet_id = digitalocean_droplet.app.id
}

# In front of the server's own ufw (cloud-init), the same openings: SSH from
# admin_cidrs only, HTTP and HTTPS (HTTP/3 on UDP 443) from anywhere. IPv4
# only, like the server. Each inline Trivy exception marks a rule whose purpose
# is to be open (DIG-0001 inbound, DIG-0003 outbound), with the reason.
resource "digitalocean_firewall" "app" {
  name        = local.name
  droplet_ids = [digitalocean_droplet.app.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.admin_cidrs
  }

  inbound_rule {
    protocol   = "tcp"
    port_range = "80"
    # trivy:ignore:DIG-0001 -- the public site: Caddy redirects to HTTPS and answers the ACME HTTP-01 challenge here.
    source_addresses = ["0.0.0.0/0"]
  }

  inbound_rule {
    protocol   = "tcp"
    port_range = "443"
    # trivy:ignore:DIG-0001 -- the public site itself (HTTPS), for every visitor.
    source_addresses = ["0.0.0.0/0"]
  }

  inbound_rule {
    protocol   = "udp"
    port_range = "443"
    # trivy:ignore:DIG-0001 -- the public site over HTTP/3, which Caddy serves on UDP 443.
    source_addresses = ["0.0.0.0/0"]
  }

  # Outbound stays open, as with ufw's defaults in the manual setup: the
  # server pulls images (GHCR, Docker Hub), packages and certificates, and the
  # API reaches what each project configures (Sentry, an OTLP endpoint, a mail
  # service) on ports this file cannot know.
  outbound_rule {
    protocol   = "tcp"
    port_range = "1-65535"
    # trivy:ignore:DIG-0003 -- registries, packages, ACME and the project's own services, on ports chosen per project.
    destination_addresses = ["0.0.0.0/0"]
  }

  outbound_rule {
    protocol   = "udp"
    port_range = "1-65535"
    # trivy:ignore:DIG-0003 -- DNS and NTP, plus HTTP/3 to the project's services.
    destination_addresses = ["0.0.0.0/0"]
  }

  outbound_rule {
    protocol = "icmp"
    # trivy:ignore:DIG-0003 -- path MTU discovery and diagnostics.
    destination_addresses = ["0.0.0.0/0"]
  }
}

resource "digitalocean_record" "app" {
  count = var.manage_dns ? 1 : 0

  domain = var.dns_zone
  type   = "A"
  name   = local.dns_record_name
  value  = digitalocean_reserved_ip.app.ip_address
  ttl    = 300
}
