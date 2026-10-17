variable "subscription_id" {
  description = "Landing zone subscription."
  type        = string
}

variable "location" {
  description = "Must match the landing zone's allowed-locations policy."
  type        = string
  default     = "northcentralus"
}

variable "prefix" {
  description = "Landing zone naming prefix."
  type        = string
  default     = "alz"
}

variable "name" {
  description = "Workload name, as in the landing zone's workloads/<name>.yaml."
  type        = string
  default     = "balcony"
}

variable "image_tag" {
  description = "Tag of the balcony image in the workload registry; CI passes the commit SHA."
  type        = string
}

variable "google_client_id" {
  description = "OAuth 2.0 client ID (Google Cloud console, Web application)."
  type        = string
}

variable "google_client_secret" {
  description = "OAuth 2.0 client secret. Supply via TF_VAR_google_client_secret, never in a committed file."
  type        = string
  sensitive   = true
}

variable "max_replicas" {
  description = "Chat rooms live in process memory, so this stays 1 until a Socket.IO adapter (e.g. Redis) is added."
  type        = number
  default     = 1
}
