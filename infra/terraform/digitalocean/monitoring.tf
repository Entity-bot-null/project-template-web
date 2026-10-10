# Alerts by email to alert_emails (docs/alerting.md, docs/observability.md):
# resource pressure on the server and the database, the site seen from
# outside, and the certificate Caddy renews.

locals {
  resource_alerts = {
    cpu = {
      what      = "CPU"
      droplet   = "v1/insights/droplet/cpu"
      database  = "v1/dbaas/alerts/cpu_alerts"
      threshold = var.alert_thresholds.cpu_percent
    }
    memory = {
      what      = "memory"
      droplet   = "v1/insights/droplet/memory_utilization_percent"
      database  = "v1/dbaas/alerts/memory_utilization_alerts"
      threshold = var.alert_thresholds.memory_percent
    }
    disk = {
      what      = "disk"
      droplet   = "v1/insights/droplet/disk_utilization_percent"
      database  = "v1/dbaas/alerts/disk_utilization_alerts"
      threshold = var.alert_thresholds.disk_percent
    }
  }
}

# docs/alerting.md, CPU or memory pressure: sustained, not a spike. 10 minutes
# is the closest window DigitalOcean offers to the catalog's 15.
resource "digitalocean_monitor_alert" "server" {
  for_each = local.resource_alerts

  description = "${local.name} server: ${each.value.what} above ${each.value.threshold} %"
  type        = each.value.droplet
  compare     = "GreaterThan"
  value       = each.value.threshold
  window      = "10m"
  entities    = [digitalocean_droplet.app.id]
  enabled     = true

  alerts {
    email = var.alert_emails
  }
}

resource "digitalocean_monitor_alert" "database" {
  for_each = local.resource_alerts

  description = "${local.name} database: ${each.value.what} above ${each.value.threshold} %"
  type        = each.value.database
  compare     = "GreaterThan"
  value       = each.value.threshold
  window      = "10m"
  entities    = [digitalocean_database_cluster.app.id]
  enabled     = true

  alerts {
    email = var.alert_emails
  }
}

# The external check of docs/observability.md#uptime-monitoring, every minute
# from four regions. It probes /healthz, the web server's public health
# check. The API's /api/health/ready answers 404 from outside on purpose (the
# probes stay private, and the deploy smoke test checks that they do), and
# DigitalOcean counts any status outside 2xx as down, so readiness cannot be
# watched from here: the database alerts above, and DigitalOcean's own
# notices of the cluster (failovers, maintenance) to the team's contact
# email, cover the database side.
resource "digitalocean_uptime_check" "app" {
  name    = "${local.name} https://${var.domain}/healthz"
  type    = "https"
  target  = "https://${var.domain}/healthz"
  regions = ["us_east", "us_west", "eu_west", "se_asia"]
  enabled = true
}

# Down everywhere for two minutes (two checks in a row): one failing region is
# usually the network on the way, not the site.
resource "digitalocean_uptime_alert" "down" {
  name     = "${local.name} is down"
  check_id = digitalocean_uptime_check.app.id
  type     = "down_global"
  period   = "2m"

  notifications {
    email = var.alert_emails
  }
}

# Caddy renews 30 days before expiry: 14 days left means renewal has failed
# for two weeks (DNS, port 80 closed, a rate limit).
resource "digitalocean_uptime_alert" "certificate" {
  name       = "${local.name} certificate expires within 14 days"
  check_id   = digitalocean_uptime_check.app.id
  type       = "ssl_expiry"
  threshold  = 14
  comparison = "less_than"
  period     = "2m"

  notifications {
    email = var.alert_emails
  }
}
