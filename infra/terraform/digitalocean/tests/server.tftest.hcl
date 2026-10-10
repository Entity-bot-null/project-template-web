# `terraform test` (run by `pnpm iac:check` with -var-file=tests/fixture.tfvars):
# the configuration against the guide it reproduces, docs/deploy-vps.md, and
# the inputs it must refuse. The DigitalOcean provider is mocked: nothing is
# created, no token is needed. What only DigitalOcean can tell (the API
# accepting each value) is checked by a real plan and apply, not here.

mock_provider "digitalocean" {
  # Values the mocks cannot invent: a numeric Droplet ID (other resources take
  # it as a number), and addresses and ports of the right shape.
  mock_resource "digitalocean_droplet" {
    defaults = {
      id  = "100000001"
      urn = "do:droplet:100000001"
    }
  }

  mock_resource "digitalocean_reserved_ip" {
    defaults = {
      ip_address = "192.0.2.10"
      urn        = "do:reservedip:192.0.2.10"
    }
  }

  mock_resource "digitalocean_database_cluster" {
    defaults = {
      private_host = "private-acme-portal-staging-do-user-1-0.db.ondigitalocean.com"
      port         = 25060
    }
  }
}

run "server_matches_the_guide" {
  command = apply

  # The Droplet: Ubuntu LTS, the guide's size, metrics agent, private network,
  # IPv4 only (the edge network has no IPv6), backups on.
  assert {
    condition = (
      digitalocean_droplet.app.image == "ubuntu-24-04-x64" &&
      digitalocean_droplet.app.size == "s-2vcpu-4gb" &&
      digitalocean_droplet.app.monitoring &&
      !digitalocean_droplet.app.ipv6 &&
      digitalocean_droplet.app.backups &&
      digitalocean_droplet.app.vpc_uuid == digitalocean_vpc.app.id &&
      digitalocean_droplet.app.ssh_keys == toset([digitalocean_ssh_key.deploy.id])
    )
    error_message = "The Droplet differs from the guide's server."
  }

  # The account key DigitalOcean needs (without one it emails a root
  # password) is the environment's own deploy key: an account refuses a public
  # key it holds already, and staging and production usually share the
  # administrator's key.
  assert {
    condition = (
      digitalocean_ssh_key.deploy.public_key == var.deploy_ssh_public_key &&
      strcontains(digitalocean_ssh_key.deploy.name, var.environment)
    )
    error_message = "The account key must be this environment's deploy key, named after the environment."
  }

  # Sections 3 and 4 in the user data.
  assert {
    condition     = startswith(digitalocean_droplet.app.user_data, "#cloud-config\n")
    error_message = "The user data must start with #cloud-config."
  }

  assert {
    condition = (
      yamldecode(digitalocean_droplet.app.user_data).users[0].name == var.admin_username &&
      yamldecode(digitalocean_droplet.app.user_data).users[0].ssh_authorized_keys == [var.admin_ssh_public_key] &&
      yamldecode(digitalocean_droplet.app.user_data).users[1].name == "deploy" &&
      yamldecode(digitalocean_droplet.app.user_data).users[1].ssh_authorized_keys == [var.deploy_ssh_public_key] &&
      !can(yamldecode(digitalocean_droplet.app.user_data).users[1].sudo) &&
      yamldecode(digitalocean_droplet.app.user_data).disable_root == true &&
      yamldecode(digitalocean_droplet.app.user_data).ssh_pwauth == false
    )
    error_message = "Users: the administrator and deploy with their keys, deploy without sudo, no root, no passwords."
  }

  assert {
    condition = (
      strcontains(yamldecode(digitalocean_droplet.app.user_data).apt.sources["docker.list"].source, "https://download.docker.com/linux/ubuntu $RELEASE stable") &&
      strcontains(yamldecode(digitalocean_droplet.app.user_data).apt.sources["docker.list"].source, "signed-by=$KEY_FILE") &&
      startswith(yamldecode(digitalocean_droplet.app.user_data).apt.sources["docker.list"].key, "-----BEGIN PGP PUBLIC KEY BLOCK-----\n") &&
      length(setsubtract(
        ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin", "ufw", "unattended-upgrades"],
        yamldecode(digitalocean_droplet.app.user_data).packages,
      )) == 0
    )
    error_message = "Docker must come from Docker's repository, signed by the committed key, with the guide's packages."
  }

  assert {
    condition = alltrue([
      for line in [
        "ufw allow OpenSSH",
        "ufw allow 80/tcp",
        "ufw allow 443/tcp",
        "ufw allow 443/udp",
        "ufw --force enable",
        "usermod -aG docker deploy",
        "install -d -m 755 -o deploy -g deploy /srv/app",
        "sshd -t",
      ] : strcontains(yamldecode(digitalocean_droplet.app.user_data).runcmd[0], line)
    ])
    error_message = "runcmd must run the guide's firewall, docker group and /srv/app commands."
  }

  assert {
    condition = alltrue([
      for setting in ["PermitRootLogin no", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "AllowUsers ${var.admin_username} deploy"] :
      strcontains(one([for file in yamldecode(digitalocean_droplet.app.user_data).write_files : file.content if file.path == "/etc/ssh/sshd_config.d/10-hardening.conf"]), setting)
    ])
    error_message = "SSH must refuse root, passwords and every user but the administrator and deploy."
  }

  # The cloud firewall: SSH from admin_cidrs only, the web ports from anywhere,
  # nothing else in.
  assert {
    condition = (
      length(digitalocean_firewall.app.inbound_rule) == 4 &&
      toset(one([for rule in digitalocean_firewall.app.inbound_rule : rule.source_addresses if rule.port_range == "22"])) == toset(var.admin_cidrs) &&
      toset([for rule in digitalocean_firewall.app.inbound_rule : "${rule.protocol}/${rule.port_range}" if toset(rule.source_addresses) == toset(["0.0.0.0/0"])]) == toset(["tcp/80", "tcp/443", "udp/443"]) &&
      toset([for id in digitalocean_firewall.app.droplet_ids : tostring(id)]) == toset([digitalocean_droplet.app.id])
    )
    error_message = "Inbound: SSH from admin_cidrs only, TCP 80 and 443 and UDP 443 from anywhere, nothing else."
  }

  # The database: PostgreSQL in the private network, reachable from the server
  # only, never destroyed by a plan (prevent_destroy, not testable here).
  assert {
    condition = (
      digitalocean_database_cluster.app.engine == "pg" &&
      digitalocean_database_cluster.app.version == "18" &&
      digitalocean_database_cluster.app.private_network_uuid == digitalocean_vpc.app.id &&
      length(digitalocean_database_firewall.app.rule) == 1 &&
      one(digitalocean_database_firewall.app.rule).type == "droplet" &&
      one(digitalocean_database_firewall.app.rule).value == digitalocean_droplet.app.id
    )
    error_message = "The database must be PostgreSQL in the VPC, admitting the server only."
  }

  # TLS with libpq's meaning of require (encrypted, the certificate not
  # checked): node-postgres alone reads require as verify-full, and refuses the
  # cluster's certificate, which DigitalOcean's own CA signs.
  assert {
    condition = (
      startswith(output.database_migrator_url, "postgresql://app_migrator:${random_password.migrator.result}@${digitalocean_database_cluster.app.private_host}:") &&
      endswith(output.database_migrator_url, "/app?sslmode=require&uselibpqcompat=true") &&
      startswith(output.database_runtime_url, "postgresql://app_runtime:${random_password.runtime.result}@${digitalocean_database_cluster.app.private_host}:") &&
      endswith(output.database_runtime_url, "/app?sslmode=require&uselibpqcompat=true") &&
      random_password.migrator.result != random_password.runtime.result
    )
    error_message = "The connection strings must use each role's own password, the private host, the database app and TLS as libpq means it."
  }

  # DNS, the reserved address and the alerts.
  assert {
    condition = (
      digitalocean_record.app[0].domain == "example.com" &&
      digitalocean_record.app[0].name == "staging" &&
      digitalocean_record.app[0].type == "A" &&
      digitalocean_record.app[0].value == digitalocean_reserved_ip.app.ip_address &&
      tostring(digitalocean_reserved_ip_assignment.app.droplet_id) == digitalocean_droplet.app.id
    )
    error_message = "The A record must point the domain at the reserved address of the server."
  }

  assert {
    condition = (
      digitalocean_uptime_check.app.target == "https://staging.example.com/healthz" &&
      digitalocean_uptime_alert.down.type == "down_global" &&
      digitalocean_uptime_alert.certificate.type == "ssl_expiry" &&
      length(digitalocean_monitor_alert.server) == 3 &&
      length(digitalocean_monitor_alert.database) == 3 &&
      alltrue([for alert in values(digitalocean_monitor_alert.server) : alert.entities == toset([digitalocean_droplet.app.id]) && one(alert.alerts).email == var.alert_emails])
    )
    error_message = "The uptime check, its alerts and the six resource alerts must target this environment."
  }
}

run "dns_left_to_the_provider" {
  command = plan

  variables {
    manage_dns = false
    dns_zone   = null
  }

  assert {
    condition     = length(digitalocean_record.app) == 0
    error_message = "Without manage_dns, Terraform must not create a DNS record."
  }
}

run "apex_domain" {
  command = plan

  variables {
    domain   = "example.com"
    dns_zone = "example.com"
  }

  assert {
    condition     = digitalocean_record.app[0].name == "@"
    error_message = "A domain equal to its zone is the zone's own record (@)."
  }
}

run "refuses_ssh_without_sources" {
  command = plan

  variables {
    admin_cidrs = []
  }

  expect_failures = [var.admin_cidrs]
}

run "refuses_ipv6_ssh_sources" {
  command = plan

  variables {
    admin_cidrs = ["2001:db8::/32"]
  }

  expect_failures = [var.admin_cidrs]
}

run "refuses_a_domain_outside_the_zone" {
  command = plan

  variables {
    dns_zone = "example.org"
  }

  expect_failures = [var.dns_zone]
}

run "refuses_an_unknown_environment" {
  command = plan

  variables {
    environment = "prod"
  }

  expect_failures = [var.environment]
}

run "refuses_a_non_lts_image" {
  command = plan

  variables {
    droplet_image = "ubuntu-25-04-x64"
  }

  expect_failures = [var.droplet_image]
}

run "refuses_a_vpc_range_docker_uses" {
  command = plan

  variables {
    vpc_ip_range = "172.30.0.0/24"
  }

  expect_failures = [var.vpc_ip_range]
}

run "refuses_postgres_older_than_16" {
  command = plan

  variables {
    postgres_version = "15"
  }

  expect_failures = [var.postgres_version]
}

run "refuses_a_standby_node_on_the_smallest_plan" {
  command = plan

  variables {
    database_size       = "db-s-1vcpu-1gb"
    database_node_count = 2
  }

  expect_failures = [var.database_node_count]
}

run "standby_nodes_on_a_larger_plan" {
  command = plan

  variables {
    database_size       = "db-s-1vcpu-2gb"
    database_node_count = 2
  }

  assert {
    condition     = digitalocean_database_cluster.app.node_count == 2
    error_message = "A plan above the smallest one takes standby nodes."
  }
}

run "refuses_the_administrator_key_as_deploy_key" {
  command = plan

  variables {
    # The fixture's administrator key, under another comment.
    deploy_ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICceJgSoFsOmi6WcMmpHlMEuAEdvCitSG+sYFWPadueK github-deploy-staging"
  }

  expect_failures = [var.deploy_ssh_public_key]
}

run "refuses_root_as_administrator" {
  command = plan

  variables {
    admin_username = "root"
  }

  expect_failures = [var.admin_username]
}

run "refuses_a_key_with_a_second_line" {
  command = plan

  variables {
    deploy_ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBceGNqTltI0mFsrUWTvg2Ro4mIK1Dp3kbK8eDJ/r+GR x\nruncmd: [reboot]"
  }

  expect_failures = [var.deploy_ssh_public_key]
}

run "refuses_a_domain_with_a_scheme" {
  command = plan

  variables {
    domain = "https://staging.example.com"
  }

  expect_failures = [var.domain]
}
