# --- Landing zone (alz-parkrrr, workloads/balcony.yaml) ---------------------

data "azurerm_resource_group" "workload" {
  name = "${local.name}-rg"
}

data "azurerm_subnet" "apps" {
  name                 = "${local.name}-snet"
  virtual_network_name = "${var.prefix}-hub-vnet"
  resource_group_name  = "${var.prefix}-network-rg"
}

data "azurerm_subnet" "private_endpoints" {
  name                 = "${var.prefix}-pep-snet"
  virtual_network_name = "${var.prefix}-hub-vnet"
  resource_group_name  = "${var.prefix}-network-rg"
}

data "azurerm_private_dns_zone" "cosmos" {
  name                = "privatelink.documents.azure.com"
  resource_group_name = "${var.prefix}-network-rg"
}

data "azurerm_log_analytics_workspace" "platform" {
  name                = "${var.prefix}-logs-law"
  resource_group_name = "${var.prefix}-platform-rg"
}

resource "random_string" "suffix" {
  length  = 6
  lower   = true
  upper   = false
  numeric = true
  special = false
}

# --- Network ---------------------------------------------------------------

# The landing zone denies inbound Internet on this subnet at priority 4000.
# The environment's public ingress needs these ports through
# (https://learn.microsoft.com/azure/container-apps/firewall-integration).
resource "azurerm_network_security_rule" "allow_ingress" {
  name                        = "allow-container-apps-ingress"
  resource_group_name         = data.azurerm_resource_group.workload.name
  network_security_group_name = "${local.name}-nsg"
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_ranges     = ["80", "443", "31080", "31443"]
  source_address_prefix       = "Internet"
  destination_address_prefix  = data.azurerm_subnet.apps.address_prefixes[0]
}

# --- Identity --------------------------------------------------------------

# User-assigned so its AcrPull grant exists before the app's first image pull.
resource "azurerm_user_assigned_identity" "app" {
  name                = "${local.name}-app-id"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.workload.name
  tags                = local.tags
}

# --- Registry --------------------------------------------------------------

# Basic has no private endpoint support (Premium does, at ~$50/month); pulls
# and pushes are Entra-authenticated, with admin credentials off.
resource "azurerm_container_registry" "main" {
  name                = replace("${local.name}${random_string.suffix.result}", "-", "")
  location            = var.location
  resource_group_name = data.azurerm_resource_group.workload.name
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

# --- Cosmos DB (chat history) ----------------------------------------------

resource "azurerm_cosmosdb_account" "main" {
  name                = "${local.name}-cosmos-${random_string.suffix.result}"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.workload.name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  public_network_access_enabled = false
  local_authentication_enabled  = false

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = var.location
    failover_priority = 0
  }

  tags = local.tags
}

resource "azurerm_cosmosdb_sql_database" "main" {
  name                = "balcony"
  resource_group_name = data.azurerm_resource_group.workload.name
  account_name        = azurerm_cosmosdb_account.main.name
}

# One logical partition per video, so loading a room's history is a single-partition query.
resource "azurerm_cosmosdb_sql_container" "messages" {
  name                = "messages"
  resource_group_name = data.azurerm_resource_group.workload.name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_paths = ["/videoId"]

  # Messages expire 30 days after they're written (Cosmos counts from _ts, and messages are
  # never edited). Expired messages drop out of queries at once and are deleted in the
  # background. Keep in sync with MESSAGE_RETENTION_MS in server/src/store.ts.
  default_ttl = 30 * 24 * 60 * 60
}

# Timed reactions, partitioned the same way: a room loads all of its reactions in one query.
# Reactions are anonymous and kept for good, so replays keep working.
resource "azurerm_cosmosdb_sql_container" "reactions" {
  name                = "reactions"
  resource_group_name = data.azurerm_resource_group.workload.name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_paths = ["/videoId"]
}

# Per-viewer reaction counters for the 50-per-video limit, keyed by a hash of the user ID.
# Each expires 30 days after the viewer's last reaction on that video (Cosmos counts from the
# last write). Keep in sync with QUOTA_RETENTION_MS in server/src/store.ts.
resource "azurerm_cosmosdb_sql_container" "reaction_quotas" {
  name                = "reaction-quotas"
  resource_group_name = data.azurerm_resource_group.workload.name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_paths = ["/videoId"]
  default_ttl         = 30 * 24 * 60 * 60
}

resource "azurerm_cosmosdb_sql_role_assignment" "app" {
  resource_group_name = data.azurerm_resource_group.workload.name
  account_name        = azurerm_cosmosdb_account.main.name
  role_definition_id  = "${azurerm_cosmosdb_account.main.id}/sqlRoleDefinitions/${local.cosmos_data_contributor_role_id}"
  principal_id        = azurerm_user_assigned_identity.app.principal_id
  scope               = azurerm_cosmosdb_account.main.id
}

resource "azurerm_private_endpoint" "cosmos" {
  name                          = "${local.name}-cosmos-pep"
  location                      = var.location
  resource_group_name           = data.azurerm_resource_group.workload.name
  subnet_id                     = data.azurerm_subnet.private_endpoints.id
  custom_network_interface_name = "${local.name}-cosmos-pep-nic"

  private_service_connection {
    name                           = "cosmos"
    private_connection_resource_id = azurerm_cosmosdb_account.main.id
    subresource_names              = ["Sql"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [data.azurerm_private_dns_zone.cosmos.id]
  }

  tags = local.tags
}

# --- Container Apps --------------------------------------------------------

resource "azurerm_container_app_environment" "main" {
  name                       = "${local.name}-cae"
  location                   = var.location
  resource_group_name        = data.azurerm_resource_group.workload.name
  logs_destination           = "log-analytics" # azurerm 5 requires this explicitly
  log_analytics_workspace_id = data.azurerm_log_analytics_workspace.platform.id

  infrastructure_subnet_id = data.azurerm_subnet.apps.id
  # Exempted from the managedBy tag policy by the landing zone (managed_resource_group: true).
  infrastructure_resource_group_name = "${local.name}-managed-rg"
  internal_load_balancer_enabled     = false

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  tags = local.tags
}

# --- Monitoring ------------------------------------------------------------

# Stores its data in the platform workspace, so telemetry is kept for that workspace's 30 days.
resource "azurerm_application_insights" "main" {
  name                = "${local.name}-appi"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.workload.name
  workspace_id        = data.azurerm_log_analytics_workspace.platform.id
  application_type    = "Node.JS"
  # A backstop on top of the app's sampling: ~3 GB a month at most, inside Log Analytics' free 5 GB.
  daily_data_cap_in_gb = 0.1
  tags                 = local.tags
}

resource "random_password" "session" {
  length  = 48
  special = false
}

resource "azurerm_container_app" "main" {
  name                         = local.app_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = data.azurerm_resource_group.workload.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  # Matches the images CI keeps in the registry; an older revision's image is gone anyway.
  max_inactive_revisions = 5

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "google-client-secret"
    value = var.google_client_secret
  }

  secret {
    name  = "session-secret"
    value = random_password.session.result
  }

  # Its key can only send telemetry. Signing in with the app's identity instead would need a
  # Monitoring Metrics Publisher role assignment, which the deploy identity can't grant.
  secret {
    name  = "appinsights-connection-string"
    value = azurerm_application_insights.main.connection_string
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = var.max_replicas

    container {
      name   = "balcony"
      image  = "${azurerm_container_registry.main.login_server}/balcony:${var.image_tag}"
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "BASE_URL"
        value = local.base_url
      }
      env {
        name  = "GOOGLE_CLIENT_ID"
        value = var.google_client_id
      }
      env {
        name        = "GOOGLE_CLIENT_SECRET"
        secret_name = "google-client-secret"
      }
      env {
        name        = "SESSION_SECRET"
        secret_name = "session-secret"
      }
      env {
        name  = "COSMOS_ENDPOINT"
        value = azurerm_cosmosdb_account.main.endpoint
      }
      # Tells DefaultAzureCredential which user-assigned identity to use.
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.app.client_id
      }
      env {
        name        = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        secret_name = "appinsights-connection-string"
      }
      # The role name Application Insights shows for this app.
      env {
        name  = "OTEL_SERVICE_NAME"
        value = "balcony"
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/healthz"
        port      = 8080
      }

      readiness_probe {
        transport = "HTTP"
        path      = "/healthz"
        port      = 8080
      }
    }
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_cosmosdb_sql_role_assignment.app,
    azurerm_private_endpoint.cosmos,
  ]
}
