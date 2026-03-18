output "droplet_id" {
  value = digitalocean_droplet.server.id
}

output "droplet_ipv4" {
  value = digitalocean_droplet.server.ipv4_address
}

output "reserved_ip" {
  value = digitalocean_reserved_ip.server.ip_address
}

output "volume_id" {
  value = digitalocean_volume.data.id
}
