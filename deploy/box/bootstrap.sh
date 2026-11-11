# The instance's first boot, after the stack's user data has written
# /etc/payonce/stack.env and the files in deploy/box. It installs the base only:
# Node 24, pnpm 12.5.1, nginx, the AWS CLI, the payonce user and the units. The
# app arrives later, from CI, through the PayOnce-Deploy SSM document.
export DEBIAN_FRONTEND=noninteractive HOME=/root

# The subnet gives no public address at launch, so wait until the Elastic IP is
# on the instance before anything reaches the internet.
imds() {
  local token
  token=$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
  curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}
for _ in $(seq 1 180); do
  if imds public-ipv4 >/dev/null 2>&1; then
    break
  fi
  sleep 5
done
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 10 https://nodejs.org/dist/; then
    break
  fi
  sleep 5
done

apt-get update -q
# No SSH on this box: Session Manager is the only shell, so sshd goes entirely.
systemctl disable --now ssh.socket ssh.service 2>/dev/null || true
apt-get purge -y -q openssh-server
systemctl daemon-reload
# Start from every pending update, not only the security ones unattended-upgrades takes.
apt-get upgrade -y -q -o Dpkg::Options::=--force-confold
apt-get install -y -q nginx nftables unzip xz-utils unattended-upgrades ca-certificates curl
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >/etc/apt/apt.conf.d/20auto-upgrades
systemctl restart systemd-journald

# Node 24: the newest 24.x for arm64, checked against nodejs.org's SHASUMS256.
work=$(mktemp -d)
cd "$work"
curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
node_tar=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-arm64\.tar\.xz$/ { print $2 }' SHASUMS256.txt)
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$node_tar"
grep " $node_tar\$" SHASUMS256.txt | sha256sum -c -
rm -rf /opt/node
mkdir -p /opt/node
tar -xJf "$node_tar" -C /opt/node --strip-components=1 --no-same-owner
ln -sfn /opt/node/bin/node /usr/local/bin/node
ln -sfn /opt/node/bin/corepack /usr/local/bin/corepack

# pnpm 12.5.1 through corepack, kept where the deploy script looks for it.
export COREPACK_HOME=/var/cache/payonce/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_AUTO_PIN=0
mkdir -p "$COREPACK_HOME" /var/cache/payonce/pnpm-store
corepack enable --install-directory /usr/local/bin pnpm
corepack install -g pnpm@12.5.1
# pnpm 12 fetches its native binary on its first run. Root runs it here, so the
# payonce user, which installs releases, only ever reads the corepack home.
pnpm --version
chmod -R a+rX "$COREPACK_HOME"

# AWS CLI v2 for arm64.
curl -fsSL -o awscliv2.zip https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip
unzip -q awscliv2.zip
./aws/install --update
aws --version
cd /
rm -rf "$work"

# The app runs as payonce and writes only its ledger, in /var/lib/payonce.
id payonce >/dev/null 2>&1 || useradd --system --home-dir /var/lib/payonce --shell /usr/sbin/nologin payonce
install -d -m 0750 -o payonce -g payonce /var/lib/payonce
install -d -m 0755 /opt/payonce /opt/payonce/releases
# From now on, and at every boot before PayOnce starts, payonce cannot reach IMDS.
systemctl daemon-reload
systemctl enable --now payonce-imds.service

# nginx answers only with the origin header. Until payonce-env writes the real
# one, it requires a value nobody has.
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/payonce /etc/nginx/sites-enabled/payonce
printf 'if ($http_x_origin_verify != "%s") { return 403; }\n' "unset-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >/etc/nginx/payonce-origin.conf
chmod 0600 /etc/nginx/payonce-origin.conf
nginx -t
systemctl enable nginx
systemctl restart nginx

systemctl enable payonce.service
/usr/local/lib/payonce/payonce-env || echo "payonce-env could not run yet. It runs again before PayOnce starts"
echo "PayOnce base installed. It starts once CI deploys a release. The nightly morning timer stays off until the owner turns it on."
