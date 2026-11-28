import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import '../sync/driver.dart' show SyncStatus;
import 'admin_screen.dart';
import 'devices_screen.dart';
import 'import_screen.dart';
import 'theme.dart';
import 'tools_screen.dart';
import 'widgets.dart';

/// 我的（phone IA）：个人中心聚合页。设备/同步状态、管理员会话、
/// 门控的管理功能（工具/导入导出/设备管理）、主题、解除配对都在这一层，
/// 替代旧的 设置页 + 头部工具弹层，层级不再超过一次推入。
class MineScreen extends StatelessWidget {
  const MineScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppController>();
    final p = MdTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: const Text('我的')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // ---- identity / sync card ----
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
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.asset('assets/logo.png', width: 28, height: 28),
                    ),
                    const SizedBox(width: 10),
                    Text('MarkDeck',
                        style: TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w800, color: p.text)),
                    const Spacer(),
                    _AdminBadge(loggedIn: app.adminLoggedIn),
                  ],
                ),
                const SizedBox(height: 12),
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
                      size: 18,
                    ),
                    const SizedBox(width: 6),
                    Text(app.syncStatus.label,
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: p.text)),
                  ],
                ),
                if (app.syncError != null) ...[
                  const SizedBox(height: 4),
                  Text(app.syncError!,
                      style: TextStyle(color: p.danger, fontSize: 12),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis),
                ],
                const SizedBox(height: 4),
                Text('服务器：${app.serverUrl ?? '-'}',
                    style: TextStyle(fontSize: 12.5, color: p.text2)),
              ],
            ),
          ),
          const SizedBox(height: 16),
          // ---- admin section ----
          _sectionLabel(p, app.adminLoggedIn ? '管理员' : '管理员（未登录）'),
          if (app.adminLoggedIn) ...[
            _entry(p, Icons.devices, '设备管理', '生成配对码 · 管理已配对设备', () async {
              await Navigator.push(
                  context, MaterialPageRoute(builder: (_) => const DevicesScreen()));
            }),
            _entry(p, Icons.logout, '退出管理员登录', '保留配对，仅退出管理员身份', () async {
              await app.logoutAdmin();
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('已退出管理员登录')));
              }
            }),
          ] else
            _entry(p, Icons.admin_panel_settings_outlined, '管理员登录',
                '登录后解锁 工具 · 导入导出 · 设备管理（密码 / TOTP）', () async {
              await _promptAdminLogin(context);
            }),
          const SizedBox(height: 16),
          // ---- gated features ----
          _sectionLabel(p, '维护'),
          _gatedEntry(context, p, Icons.build_outlined, '工具',
              '死链检测 · 重复合并 · 快照备份 · 导出', () => const ToolsScreen()),
          _gatedEntry(context, p, Icons.inventory_2_outlined, '导入导出',
              'HTML 导入 · 书签导出', () => const ImportScreen()),
          const SizedBox(height: 16),
          // ---- general ----
          _sectionLabel(p, '通用'),
          _themeCard(context, p),
          const SizedBox(height: 8),
          _entry(p, Icons.refresh, '强制重新同步', '清除本地快照并从服务器重新比对', () async {
            final messenger = ScaffoldMessenger.of(context);
            await app.forceResync();
            messenger.showSnackBar(const SnackBar(content: Text('重新同步完成')));
          }),
          const SizedBox(height: 16),
          // ---- danger zone ----
          _entry(p, Icons.link_off, '解除配对', '删除本地身份与镜像（服务器端设备请先吊销）', () async {
            await _confirmUnpair(context, app);
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
                    Text('MarkDeck', style: TextStyle(fontSize: 12, color: p.text3)),
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

  // ---- gating helper ----

  Future<void> _promptAdminLogin(BuildContext context) async {
    await Navigator.push(
        context, MaterialPageRoute(builder: (_) => const AdminScreen()));
  }

  /// Locked entry: requires an admin session. Tapping it opens the login
  /// screen and, on success, continues straight to the intended page.
  Widget _gatedEntry(
    BuildContext context,
    MdPalette p,
    IconData icon,
    String title,
    String sub,
    Widget Function() destination,
  ) {
    final app = context.watch<AppController>();
    return _entry(
      p,
      icon,
      title,
      sub,
      () async {
        if (!app.adminLoggedIn) {
          await _promptAdminLogin(context);
          if (!context.mounted || !app.adminLoggedIn) return;
        }
        if (context.mounted) {
          await Navigator.push(
              context, MaterialPageRoute(builder: (_) => destination()));
        }
      },
      locked: !app.adminLoggedIn,
    );
  }

  // ---- pieces ----

  Widget _sectionLabel(MdPalette p, String text) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 0, 8),
      child: Text(text, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: p.text3)),
    );
  }

  Widget _entry(
    MdPalette p,
    IconData icon,
    String title,
    String sub,
    VoidCallback onTap, {
    bool locked = false,
  }) {
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
            color: locked ? p.bg : p.primarySoft,
            borderRadius: BorderRadius.circular(10),
          ),
          child: locked
              ? Icon(Icons.lock_outline, size: 18, color: p.text3)
              : Icon(icon, size: 18, color: p.primary),
        ),
        title: Text(title,
            style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: locked ? p.text2 : p.text)),
        subtitle: Text(locked ? '需要管理员登录' : sub,
            style: TextStyle(fontSize: 12, color: p.text3)),
        trailing: Icon(Icons.chevron_right, size: 18, color: p.text3),
        onTap: onTap,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }

  Widget _themeCard(BuildContext context, MdPalette p) {
    final app = context.watch<AppController>();
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('配色主题', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: p.text)),
          const SizedBox(height: 4),
          Row(
            children: [
              for (final entry in themes.entries)
                Expanded(
                  child: ThemeDot(
                    id: entry.key,
                    label: entry.value.$1,
                    palette: entry.value.$2,
                    selected: app.themeId == entry.key,
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _confirmUnpair(BuildContext context, AppController app) async {
    final p = MdTheme.of(context);
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
      // root switch renders PairScreen; clear any pushed routes
      if (context.mounted) {
        Navigator.of(context, rootNavigator: true).popUntil((r) => r.isFirst);
      }
    }
  }
}

class _AdminBadge extends StatelessWidget {
  const _AdminBadge({required this.loggedIn});

  final bool loggedIn;

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: loggedIn ? p.primarySoft : p.bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: loggedIn ? p.primary : p.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            loggedIn ? Icons.verified_user_outlined : Icons.lock_outline,
            size: 12,
            color: loggedIn ? p.primary : p.text3,
          ),
          const SizedBox(width: 4),
          Text(
            loggedIn ? '管理员' : '未登录管理员',
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: loggedIn ? p.primary : p.text3,
            ),
          ),
        ],
      ),
    );
  }
}
