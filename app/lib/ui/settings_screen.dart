import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import '../sync/driver.dart' show SyncStatus;
import 'admin_screen.dart';

/// Settings: sync status card, pairing info, force resync, unpair, admin
/// mode entry, about (version = server VERSION via CI build-name).
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppController>();
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        children: [
          // ---- sync status ----
          Card(
            margin: const EdgeInsets.all(16),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        switch (app.syncStatus) {
                          SyncStatus.online => Icons.check_circle,
                          SyncStatus.disconnected => Icons.cloud_off,
                          SyncStatus.unauthorized => Icons.error_outline,
                          SyncStatus.unconfigured => Icons.help_outline,
                        },
                        color: switch (app.syncStatus) {
                          SyncStatus.online => scheme.primary,
                          SyncStatus.unconfigured => scheme.outline,
                          _ => scheme.error,
                        },
                      ),
                      const SizedBox(width: 8),
                      Text('同步状态：${app.syncStatus.label}'),
                    ],
                  ),
                  if (app.syncError != null) ...[
                    const SizedBox(height: 6),
                    Text(
                      app.syncError!,
                      style: TextStyle(color: scheme.error, fontSize: 12),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                  const SizedBox(height: 4),
                  Text(
                    '服务器：${app.serverUrl ?? '-'}',
                    style: const TextStyle(fontSize: 13),
                  ),
                ],
              ),
            ),
          ),
          // ---- actions ----
          ListTile(
            leading: const Icon(Icons.refresh),
            title: const Text('强制重新同步'),
            subtitle: const Text('清除本地快照并从服务器重新比对'),
            onTap: () async {
              await app.forceResync();
              if (context.mounted) {
                ScaffoldMessenger.of(context)
                    .showSnackBar(const SnackBar(content: Text('重新同步完成')));
              }
            },
          ),
          ListTile(
            leading: const Icon(Icons.admin_panel_settings_outlined),
            title: const Text('管理员模式'),
            subtitle: const Text('生成配对码、管理设备、TOTP、改密码'),
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => const AdminScreen()),
            ),
          ),
          ListTile(
            leading: const Icon(Icons.link_off),
            title: const Text('解除配对'),
            subtitle: const Text('删除本地身份与镜像（服务器端设备仍可吊销）'),
            onTap: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text('解除配对'),
                  content: const Text('本地书签镜像与设备身份将被删除。服务器上的设备记录请到管理页吊销。'),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
                    FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('解除')),
                  ],
                ),
              );
              if (ok == true && context.mounted) {
                await app.unpair();
              }
            },
          ),
          const Divider(height: 32),
          // ---- about ----
          FutureBuilder<PackageInfo>(
            future: PackageInfo.fromPlatform(),
            builder: (context, snap) {
              final info = snap.data;
              return ListTile(
                leading: Icon(Icons.info_outline, color: scheme.primary),
                title: const Text('关于 MarkDeck'),
                subtitle: Text(
                  info == null
                      ? '读取版本…'
                      : '版本 ${info.version} (${info.buildNumber})',
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}
