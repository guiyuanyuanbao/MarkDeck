import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import '../sync/driver.dart' show SyncStatus;
import 'admin_screen.dart';
import 'devices_screen.dart';
import 'theme.dart';

/// 设置 (web SettingsView, phone layout): sync status card, entries to
/// 设备管理 / 管理员登录, resync, unpair, about (version = server VERSION).
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppController>();
    final p = MdTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // ---- sync status card ----
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: p.border),
            ),
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
                        SyncStatus.online => p.success,
                        SyncStatus.unconfigured => p.text3,
                        _ => p.danger,
                      },
                      size: 20,
                    ),
                    const SizedBox(width: 8),
                    Text('同步状态：${app.syncStatus.label}',
                        style: TextStyle(
                            fontSize: 14, fontWeight: FontWeight.w700, color: p.text)),
                  ],
                ),
                if (app.syncError != null) ...[
                  const SizedBox(height: 6),
                  Text(app.syncError!,
                      style: TextStyle(color: p.danger, fontSize: 12),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis),
                ],
                const SizedBox(height: 4),
                Text('服务器：${app.serverUrl ?? '-'}',
                    style: TextStyle(fontSize: 13, color: p.text2)),
              ],
            ),
          ),
          const SizedBox(height: 16),
          // ---- entries ----
          _entry(p, Icons.devices, '配对设备', '生成配对码 · 管理已配对设备', () async {
            await Navigator.push(context, MaterialPageRoute(builder: (_) => const DevicesScreen()));
          }),
          _entry(p, Icons.admin_panel_settings_outlined, '管理员登录',
              '需要完整管理权限时使用（密码 / TOTP）', () async {
            await Navigator.push(
                context, MaterialPageRoute(builder: (_) => const AdminScreen()));
          }),
          _entry(p, Icons.refresh, '强制重新同步', '清除本地快照并从服务器重新比对', () async {
            final messenger = ScaffoldMessenger.of(context);
            await app.forceResync();
            messenger.showSnackBar(const SnackBar(content: Text('重新同步完成')));
          }),
          _entry(p, Icons.link_off, '解除配对', '删除本地身份与镜像（服务器端设备仍可吊销）', () async {
            final ok = await showDialog<bool>(
              context: context,
              builder: (ctx) => AlertDialog(
                title: const Text('解除配对'),
                content: const Text('本地书签镜像与设备身份将被删除。服务器上的设备记录请到设备管理吊销。'),
                actions: [
                  TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
                  FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: p.danger),
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text('解除'),
                  ),
                ],
              ),
            );
            if (ok == true && context.mounted) {
              await app.unpair();
              if (context.mounted) {
                Navigator.of(context, rootNavigator: true).popUntil((r) => r.isFirst);
              }
            }
          }),
          const SizedBox(height: 16),
          // ---- about ----
          FutureBuilder<PackageInfo>(
            future: PackageInfo.fromPlatform(),
            builder: (context, snap) {
              final info = snap.data;
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.asset('assets/logo.png', width: 20, height: 20),
                    ),
                    const SizedBox(width: 8),
                    Text('MarkDeck',
                        style: TextStyle(fontSize: 12, color: p.text3)),
                    const Spacer(),
                    Text(
                      info == null ? '' : 'v${info.version}',
                      style: TextStyle(fontSize: 12, color: p.text3),
                    ),
                  ],
                ),
              );
            },
          ),
        ],
      ),
    );
  }

  Widget _entry(MdPalette p, IconData icon, String title, String sub, VoidCallback onTap) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.border),
      ),
      child: ListTile(
        leading: Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            color: p.primarySoft,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icon, size: 18, color: p.primary),
        ),
        title: Text(title,
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: p.text)),
        subtitle: Text(sub, style: TextStyle(fontSize: 12, color: p.text3)),
        trailing: Icon(Icons.chevron_right, size: 18, color: p.text3),
        onTap: onTap,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }



}
