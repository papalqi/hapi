# HAPI CLI 配置脚本

写入/更新 HAPI CLI 的配置文件（不依赖环境变量），目标文件：

- Linux/macOS: `~/.hapi/settings.json`（或 `--hapi-home` / `$HAPI_HOME` 指定）
- Windows: `%USERPROFILE%\\.hapi\\settings.json`（或 `-HapiHome` 指定）

脚本会保留已有字段，只更新：

- `apiUrl`
- `cliApiToken`（如提供）

## Linux/macOS（bash）

```bash
./setup-hapi-cli-linux.sh --api-url https://hapi.papalqi.top --token 'YOUR_TOKEN'
```

只写 `apiUrl`（不写 token）：

```bash
./setup-hapi-cli-linux.sh --api-url https://hapi.papalqi.top
```

## Windows（PowerShell）

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-hapi-cli-windows.ps1 -ApiUrl https://hapi.papalqi.top -Token 'YOUR_TOKEN'
```

