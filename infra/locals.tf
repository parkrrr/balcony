locals {
  name = "${var.prefix}-${var.name}"

  # Inherit the landing zone's tags (managedBy, project, environment, workload).
  tags = data.azurerm_resource_group.workload.tags

  app_name = "${local.name}-app"
  base_url = "https://${local.app_name}.${azurerm_container_app_environment.main.default_domain}"

  cosmos_data_contributor_role_id = "00000000-0000-0000-0000-000000000002"
}
