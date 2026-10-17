# State container provisioned by the landing zone (workloads/balcony.yaml, tofu_state: true).
terraform {
  backend "azurerm" {
    resource_group_name  = "alz-tfstate-rg"
    storage_account_name = "alztfstate3uisf7"
    container_name       = "alz-balcony-tfstate"
    key                  = "balcony.tfstate"
    use_azuread_auth     = true
  }
}
