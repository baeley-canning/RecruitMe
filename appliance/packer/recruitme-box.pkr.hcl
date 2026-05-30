# Packer template for the RecruitMe Box appliance image.
#
# Builds an Ubuntu 24.04 LTS image with:
#   - Node 20, PostgreSQL 18, Ollama, Patchright + Chromium
#   - LibreOffice (for .doc CV extraction)
#   - Caddy, age, jq
#   - All systemd units installed but DISABLED (first-boot enables them
#     after collecting customer secrets via the wizard)
#   - Per-box identity placeholders (overwritten at first boot)
#
# Targets:
#   - virtualbox-iso: local test image for dev iteration
#   - hetzner / vultr / linode: cloud build for VM customers
#   - file: raw img output written to ./out/ for `dd`-flashing to physical
#     mini-PC SSDs
#
# Build:
#   cd appliance/packer
#   packer init .
#   packer build -only=qemu.recruitme-box recruitme-box.pkr.hcl
#
# Flash to a fresh SSD:
#   sudo dd if=out/recruitme-box.img of=/dev/sdX bs=4M status=progress conv=fsync
#
# Then plug SSD into the target mini-PC, boot, and run through the
# first-boot wizard at http://recruitme.local

packer {
  required_plugins {
    qemu = {
      source  = "github.com/hashicorp/qemu"
      version = "~> 1.0"
    }
  }
}

variable "ubuntu_iso" {
  type    = string
  default = "https://releases.ubuntu.com/24.04/ubuntu-24.04.1-live-server-amd64.iso"
}

variable "image_name" {
  type    = string
  default = "recruitme-box-0.1.0"
}

source "qemu" "recruitme-box" {
  iso_url           = var.ubuntu_iso
  iso_checksum      = "file:https://releases.ubuntu.com/24.04/SHA256SUMS"
  disk_size         = "20480M"
  format            = "qcow2"
  accelerator       = "tcg"   # use kvm if available
  memory            = 4096
  cpus              = 2
  net_device        = "virtio-net"
  disk_interface    = "virtio"
  http_directory    = "./http"
  boot_wait         = "5s"
  boot_command      = [
    "<esc><esc><esc>",
    "<enter><wait>",
    "/casper/vmlinuz ",
    "root=/dev/ram0 ramdisk_size=1500000 ip=dhcp cloud-config-url=/dev/null ",
    "autoinstall ds=nocloud-net;s=http://{{.HTTPIP}}:{{.HTTPPort}}/ ",
    "---<enter>"
  ]
  ssh_username      = "ubuntu"
  ssh_password      = "ubuntu"
  ssh_wait_timeout  = "30m"
  shutdown_command  = "echo 'ubuntu' | sudo -S poweroff"
  output_directory  = "out"
  vm_name           = "${var.image_name}.qcow2"
}

build {
  sources = ["source.qemu.recruitme-box"]

  # ── Phase 1: install OS packages ──
  provisioner "shell" {
    inline = [
      "set -eux",
      "sudo apt-get update",
      "sudo apt-get install -y curl ca-certificates gnupg2 software-properties-common ufw age jq libreoffice-core libreoffice-writer xvfb fonts-liberation",
      # PostgreSQL 18 — Ubuntu 24.04 ships 16 by default; pull from pgdg
      "curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /usr/share/keyrings/postgresql.gpg",
      "echo 'deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt noble-pgdg main' | sudo tee /etc/apt/sources.list.d/pgdg.list",
      "sudo apt-get update && sudo apt-get install -y postgresql-18",
      # Node 20 via NodeSource
      "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -",
      "sudo apt-get install -y nodejs",
      # Caddy from the official repo
      "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy.gpg",
      "echo 'deb [signed-by=/usr/share/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main' | sudo tee /etc/apt/sources.list.d/caddy.list",
      "sudo apt-get update && sudo apt-get install -y caddy",
      # Ollama
      "curl -fsSL https://ollama.com/install.sh | sh",
      "sudo systemctl enable ollama && sudo ollama pull qwen2.5:1.5b",
      # Tailscale CLI (auth-key configured at first boot)
      "curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null",
      "curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list | sudo tee /etc/apt/sources.list.d/tailscale.list",
      "sudo apt-get update && sudo apt-get install -y tailscale",
    ]
  }

  # ── Phase 2: copy app + appliance artifacts into image ──
  provisioner "file" {
    source      = "../../../RecruitMe/"     # the whole repo (excluding heavy stuff in .packerignore)
    destination = "/tmp/recruitme/"
  }

  provisioner "shell" {
    inline = [
      "sudo mkdir -p /opt/recruitme",
      "sudo cp -r /tmp/recruitme/* /opt/recruitme/",
      "sudo chown -R recruitme:recruitme /opt/recruitme || true",
      # systemd units
      "sudo cp /opt/recruitme/appliance/control-agent/recruitme-control-agent.service /etc/systemd/system/",
      "sudo cp /opt/recruitme/appliance/heartbeat/recruitme-heartbeat.service /etc/systemd/system/",
      "sudo cp /opt/recruitme/appliance/heartbeat/recruitme-heartbeat.timer /etc/systemd/system/",
      "sudo cp /opt/recruitme/appliance/heartbeat/heartbeat.sh /usr/local/bin/recruitme-heartbeat && sudo chmod +x /usr/local/bin/recruitme-heartbeat",
      # First-boot wizard service (runs once, then disables itself)
      "sudo cp /opt/recruitme/appliance/firstboot/recruitme-firstboot.service /etc/systemd/system/",
      "sudo systemctl enable recruitme-firstboot.service",
      # Pre-install npm deps for both the main app and admin-portal so
      # first boot doesn't need internet for `npm install`
      "cd /opt/recruitme && sudo -u recruitme npm install --omit=dev",
      "cd /opt/recruitme/scraper-worker && sudo -u recruitme npm install && sudo -u recruitme npm run build",
      # ufw default-deny
      "sudo ufw default deny incoming && sudo ufw default allow outgoing",
      "sudo ufw allow in 22/tcp && sudo ufw allow in 80/tcp && sudo ufw allow in 443/tcp",
      "sudo ufw allow in on tailscale0 || true",
      "echo 'y' | sudo ufw enable",
      # journald caps
      "sudo cp /opt/recruitme/appliance/packer/journald-recruitme.conf /etc/systemd/journald.conf.d/",
      # Strip Packer ssh credentials, baked dev tokens
      "sudo rm -f /home/ubuntu/.ssh/authorized_keys /tmp/recruitme",
      "sudo passwd -d ubuntu",
      "echo '[done] base image ready — first boot will run the wizard'",
    ]
  }
}
