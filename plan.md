# Enable Root Login on AWS Ubuntu Instance

The message comes from `/root/.ssh/authorized_keys` which AWS pre-populates with a command that blocks root login. Fix it by SSHing in as `ubuntu` first, then running these steps:

## Steps


The file will look like this:
```
no-port-forwarding,no-agent-forwarding,no-X11-forwarding,command="echo 'Please login as the user \"ubuntu\" rather than the user \"root\".';echo;sleep 10;exit 142" ssh-rsa AAAA...
```

**Delete everything before `ssh-rsa`** so only the key remains:
```
ssh-rsa AAAA...
```

Save and exit (`Ctrl+X`, `Y`, `Enter`).

### 3. Enable root login in sshd config
```bash
sudo nano /etc/ssh/sshd_config
```

Find and set (or add) these lines:
```
PermitRootLogin yes
```

If you see `PermitRootLogin prohibit-password` or `PermitRootLogin without-password`, change it to `yes` (for key-based auth, `prohibit-password` also works — only use `yes` if you need password auth too).

### 4. Restart SSH
```bash
sudo systemctl restart sshd
```

### 5. Test root login
```bash
ssh -i your-key.pem root@<instance-ip>
```

## For VS Code Remote-SSH

In your VS Code SSH config (`~/.ssh/config`), set:
```
Host my-aws-instance
    HostName <instance-ip>
    User root
    IdentityFile C:\path\to\your-key.pem
```

## Security Note

Running as root is discouraged on production instances. Consider using `ubuntu` user with `sudo` instead.
