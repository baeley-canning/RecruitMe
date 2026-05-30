# Full-disk encryption for the RecruitMe Box

Step-by-step playbook for enabling LUKS2 + TPM2 unlock on a new mini-PC
BEFORE running the Packer image flash. Defers Phase J6 of the appliance
build — every shipped box should go through this, but it can't be done
remotely on the dev box you're using day-to-day.

## Why this matters

Without disk encryption, anyone with physical access to a stolen box can
boot from USB, mount the SSD, and read:

- Every customer's full candidate database (PII, CVs)
- Encrypted LinkedIn / SEEK session cookies (the `SESSION_ENCRYPTION_KEY`
  is also on disk → game over)
- Postgres role passwords

TPM2 binding means the unlock key is sealed to this specific motherboard
+ firmware state. Pull the SSD into another machine → key won't unseal →
ciphertext only. A printed recovery passphrase covers "TPM died" / "the
customer needs to migrate to a new box".

## One-time setup per box

Do this on a fresh Ubuntu Server install BEFORE Packer copies the app
artifacts in. The image build expects an encrypted root partition.

```bash
# 0. Boot Ubuntu Server installer, opt into LUKS during partitioning.
#    The installer's prompt is the gentlest way; you set the unlock
#    passphrase here.
# 1. After install, log in and check the partition is LUKS:
sudo cryptsetup status /dev/dm-0
# 2. Enroll TPM2 (PCR-bound to firmware + secure boot state):
sudo systemd-cryptenroll --tpm2-device=auto \
  --tpm2-pcrs=0+2+7 \
  /dev/nvme0n1p3        # <-- the LUKS partition, NOT the unlocked /dev/dm-0
# 3. Generate + print a recovery key. Store in the customer's
#    sealed-envelope card that ships with the box.
sudo systemd-cryptenroll --recovery-key /dev/nvme0n1p3
# Write the recovery key on the printed setup card NOW; you cannot
# retrieve it later.
# 4. Test: reboot. Box should come up without prompting (TPM unseal).
sudo reboot
# 5. Verify in /etc/crypttab that the TPM keyslot is present:
cat /etc/crypttab
```

## PCR selection

`0+2+7` covers:
- **PCR 0**: BIOS / UEFI firmware
- **PCR 2**: option ROMs / EFI drivers (catches modified boot loaders)
- **PCR 7**: Secure Boot state

That's the "boot integrity" trio. Updates to the UEFI firmware will
invalidate the seal (expected — the recovery key gets used once, then
re-enroll). Don't include PCR 8/9 — they hash the kernel cmdline + initrd,
which means every Ubuntu kernel update breaks unattended boot.

## Re-enrolling after firmware update

If the customer applies a BIOS / UEFI update, the next boot will prompt
for the LUKS passphrase (the recovery key works). Then on the booted system:

```bash
sudo systemd-cryptenroll --wipe-slot=tpm2 /dev/nvme0n1p3
sudo systemd-cryptenroll --tpm2-device=auto --tpm2-pcrs=0+2+7 /dev/nvme0n1p3
```

Document this in the customer-facing runbook. Better: ship a script
`recruitme-rotate-tpm` that does it in one command.

## Secure boot

Required for the PCR 7 binding to be meaningful. Ensure:

1. Secure Boot is enabled in BIOS
2. The BIOS supervisor password is set (otherwise an attacker can flip
   Secure Boot off in BIOS and bypass the PCR check)
3. The Ubuntu signed shim is the boot loader

## Out of scope for v1

- Network-bound disk unlock (Tang/Clevis) — requires running infra in the
  customer's office; too much for v1
- HSM-backed cosign keys for update signing
- Attestation-based update gating
