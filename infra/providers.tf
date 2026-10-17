provider "azurerm" {
  subscription_id = var.subscription_id

  # The deploy identity is scoped to its resource group and cannot register
  # providers; the landing zone does that (extra_resource_providers).
  resource_provider_registrations = "none"

  features {}
}
