# The managed PostgreSQL of docs/deploy-vps.md section 5: daily backups and
# point-in-time recovery (the last 7 days) come with every DigitalOcean
# cluster, it lives in the server's private network, and only the server may
# connect to it.
#
# The roles and the database follow the guide exactly: app_migrator owns the
# database `app` and its schema, app_runtime reads and writes data only, with
# at most 50 connections. They are created by database/roles.sql, which
# `pnpm iac:database` applies from the server once the cluster and the server
# exist (docs/deploy-vps.md#provision-with-terraform-digitalocean): the
# cluster accepts connections from the server only, and SQL is the one way to
# give the migrator the database. The passwords are generated here, so the
# state holds them: keep it private (versions.tf).

resource "digitalocean_database_cluster" "app" {
  name                 = local.name
  engine               = "pg"
  version              = var.postgres_version
  size                 = var.database_size
  region               = var.region
  node_count           = var.database_node_count
  private_network_uuid = digitalocean_vpc.app.id
  tags                 = local.tags

  maintenance_window {
    day  = var.database_maintenance_window.day
    hour = var.database_maintenance_window.hour
  }

  lifecycle {
    # Deleting the cluster deletes the database with it. A plan that would
    # (terraform destroy, a change that forces a new cluster) stops here;
    # docs/deploy-vps.md#teardown says how to delete it on purpose.
    prevent_destroy = true
  }
}

# Trusted sources: this server only, over the private network. Without a
# rule, DigitalOcean would accept connections from anywhere.
resource "digitalocean_database_firewall" "app" {
  cluster_id = digitalocean_database_cluster.app.id

  rule {
    type  = "droplet"
    value = digitalocean_droplet.app.id
  }
}

# The guide's `openssl rand -hex 24`: 48 random characters, letters and digits
# only, so they go into a connection string as they are.
resource "random_password" "migrator" {
  length  = 48
  special = false
}

resource "random_password" "runtime" {
  length  = 48
  special = false
}

locals {
  # TLS required, with libpq's meaning: encrypted, over the private network to
  # a cluster that admits this server only. Without uselibpqcompat, the API's
  # driver (node-postgres) reads require as verify-full and refuses the
  # cluster's certificate, which DigitalOcean's own CA signs; Prisma's
  # migration engine ignores the parameter.
  database_url = {
    for role, password in {
      app_migrator = random_password.migrator.result
      app_runtime  = random_password.runtime.result
    } :
    role => format(
      "postgresql://%s:%s@%s:%d/app?sslmode=require&uselibpqcompat=true",
      role,
      password,
      digitalocean_database_cluster.app.private_host,
      digitalocean_database_cluster.app.port,
    )
  }
}
