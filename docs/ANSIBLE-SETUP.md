# Ansible setup (split frontend + backend VMs)

Lightweight Ansible scaffold aligned with **[PROD-SPLIT-NGINX.md](./PROD-SPLIT-NGINX.md)** (two-VM production: static + TLS on one host, API + `/ws` on the other).

It supports:

- common host prep (`deploy` user, base packages)
- backend deploy (git pull, `npm ci`, workspace builds, nginx config, systemd restarts)
- frontend deploy (git pull, `npm ci`, frontend build, static publish to `/var/www/discord-frontend`, nginx config)

---

## 1) Inventory

Copy the example inventory and set your host IPs:

```bash
cd ansible
cp inventory/hosts.ini.example inventory/hosts.ini
```

---

## 2) Variables

Copy shared vars and set values:

```bash
cp group_vars/all.yml.example group_vars/all.yml
```

Required values to verify:

- `repo_url`
- `deploy_branch`
- `deploy_user`
- `deploy_path`
- `frontend_web_root`
- nginx source paths (`frontend_nginx_conf_src`, `backend_nginx_conf_src`)

Optional:

- `deploy_public_key` if you want Ansible to enforce/update `authorized_keys`.

---

## 3) Run

From `ansible/`:

```bash
ansible-playbook playbooks/site.yml
```

With explicit SSH private key:

```bash
ansible-playbook -i inventory/hosts.ini --private-key ~/.ssh/id_ed25519 playbooks/site.yml
```

Dry run:

```bash
ansible-playbook -i inventory/hosts.ini --check playbooks/site.yml
```

---

## 4) Notes

- This assumes Node.js is already installed on hosts and available to `deploy`.
- Backend service restart list is controlled by `backend_systemd_services` in `group_vars/all.yml`.
- If your host-specific values differ, split variables into `group_vars/frontend.yml` and `group_vars/backend.yml`.
