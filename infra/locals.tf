locals {
  name = "${var.prefix}-${var.name}"

  # Inherit the landing zone's tags (managedBy, project, environment, workload).
  tags = data.azurerm_resource_group.workload.tags

  app_name = "${local.name}-app"
  # The custom domain and its certificate were bound by hand in Azure, outside this config.
  base_url = "https://balcony.chat"

  cosmos_data_contributor_role_id = "00000000-0000-0000-0000-000000000002"
}
