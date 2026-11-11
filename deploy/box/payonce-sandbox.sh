# Sourced by payonce-deploy and payonce-morning. as_payonce runs a command as the
# payonce user in a transient unit with payonce.service's sandbox: no new
# privileges, a read-only system, no home directories, a private /tmp, and no
# route to the instance metadata service. The options before -- go to
# systemd-run, such as the working directory and the paths the unit may write.
as_payonce() {
  local options=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    options+=("$1")
    shift
  done
  shift
  systemd-run --wait --pipe --collect --quiet \
    -p User=payonce -p Group=payonce \
    -p Requires=payonce-imds.service -p After=payonce-imds.service \
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
    -p PrivateDevices=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes \
    -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes \
    -p MemoryMax=1200M -p "IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128" \
    "${options[@]}" -- "$@"
}
