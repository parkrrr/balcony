output "url" {
  value = local.base_url
}

output "oauth_redirect_uri" {
  description = "Add to the Google OAuth client's authorized redirect URIs."
  value       = "${local.base_url}/auth/callback"
}

output "registry_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "registry_name" {
  value = azurerm_container_registry.main.name
}
