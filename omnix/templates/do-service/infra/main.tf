data "digitalocean_ssh_key" "op" {
  name = var.ssh_key_name
}

resource "digitalocean_volume" "data" {
  region                  = var.region
  name                    = "my-service-data"
  size                    = var.volume_size_gb
  initial_filesystem_type = "ext4"
  description             = "Persistent data volume"
}

resource "digitalocean_droplet" "server" {
  image    = "ubuntu-24-04-x64"
  name     = "my-service-nixos"
  region   = var.region
  size     = var.droplet_size
  ssh_keys = [data.digitalocean_ssh_key.op.id]
}

resource "digitalocean_volume_attachment" "data" {
  droplet_id = digitalocean_droplet.server.id
  volume_id  = digitalocean_volume.data.id
}

resource "digitalocean_reserved_ip" "server" {
  region     = var.region
  droplet_id = digitalocean_droplet.server.id
}
