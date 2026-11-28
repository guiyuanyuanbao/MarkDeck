import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import 'theme.dart';

/// Tools hub: dead-link scan, duplicate merge, folder-duplicate merge,
/// snapshots, HTML import, HTML/JSON export — all via paired-token routes.
class ToolsScreen extends StatelessWidget {
  const ToolsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    final app = context.read<AppController>();
    return Scaffold(
      appBar: AppBar(title: const Text('工具')),
      body: ListView(
        children: [
          const _SectionTitle('维护'),
          ListTile(
            leading: Icon(Icons.link_off, color: p.primary),
            title: const Text('死链检测'),
            subtitle: const Text('扫描全部书签，区分真死链与反爬拦截'),
            onTap: () => _deadLinks(context, app),
          ),
          ListTile(
            leading: Icon(Icons.merge_type, color: p.primary),
            title: const Text('重复书签合并'),
            subtitle: const Text('同 URL 书签合并为一条'),
            onTap: () => _mergeDuplicates(context, app, '/api/tools/duplicates/merge', '重复书签'),
          ),
          ListTile(
            leading: Icon(Icons.folder_copy_outlined, color: p.primary),
            title: const Text('重复文件夹合并'),
            subtitle: const Text('同名文件夹内容合并'),
            onTap: () => _mergeDuplicates(context, app, '/api/tools/folder-duplicates/merge', '重复文件夹'),
          ),
          const _SectionTitle('备份'),
          ListTile(
            leading: Icon(Icons.history, color: p.primary),
            title: const Text('快照'),
            subtitle: const Text('每日自动备份 + 手动快照，可恢复'),
            onTap: () => _snapshots(context, app),
          ),
          ListTile(
            leading: Icon(Icons.file_download_outlined, color: p.primary),
            title: const Text('导出 HTML'),
            subtitle: const Text('下载全部书签为 Netscape HTML'),
            onTap: () => _export(context, app, '/api/export/html', 'markdeck.html'),
          ),
          ListTile(
            leading: Icon(Icons.file_download_outlined, color: p.primary),
            title: const Text('导出 JSON'),
            subtitle: const Text('下载全部书签为 JSON'),
            onTap: () => _export(context, app, '/api/export/json', 'markdeck.json'),
          ),
        ],
      ),
    );
  }

  void _toast(BuildContext context, String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _deadLinks(BuildContext context, AppController app) async {
    _toast(context, '开始扫描…');
    try {
      await app.client.post('/api/tools/deadlinks/scan');
      // poll until done then fetch results
      for (var i = 0; i < 120; i++) {
        await Future<void>.delayed(const Duration(seconds: 1));
        final st = await app.client.get('/api/tools/deadlinks/status') as Map<String, dynamic>;
        if (st['running'] != true) break;
      }
      final r = await app.client.get('/api/tools/deadlinks') as Map<String, dynamic>;
      final dead = (r['dead'] as List? ?? []).length;
      final blocked = (r['blocked'] as List? ?? []).length;
      if (context.mounted) {
        _toast(context, '扫描完成：真死链 $dead，反爬拦截 $blocked');
      }
    } catch (e) {
      if (context.mounted) _toast(context, '扫描失败：$e');
    }
  }

  Future<void> _mergeDuplicates(BuildContext context, AppController app, String path, String label) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('合并$label'),
        content: Text('将所有$label合并为一条（保留最早创建的），操作不可撤销。继续？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('合并')),
        ],
      ),
    );
    if (ok != true) return;
    if (!context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await app.client.post(path);
      messenger.showSnackBar(const SnackBar(content: Text('合并完成')));
      await app.driver.reconcile('merge');
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('合并失败：$e')));
    }
  }

  Future<void> _snapshots(BuildContext context, AppController app) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final r = await app.client.get('/api/snapshots') as Map<String, dynamic>;
      final snaps = (r['snapshots'] as List? ?? []).cast<Map<String, dynamic>>();
      if (!context.mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('快照'),
          content: SizedBox(
            width: 300,
            height: 300,
            child: snaps.isEmpty
                ? const Center(child: Text('暂无快照'))
                : ListView(
                    children: [
                      for (final s in snaps)
                        ListTile(
                          leading: const Icon(Icons.history),
                          title: Text('${s['createdAt'] ?? s['id']}'),
                          trailing: TextButton(
                            onPressed: () async {
                              await app.client.post('/api/snapshots/${s['id']}/restore');
                              if (ctx.mounted) Navigator.pop(ctx);
                              await app.driver.reconcile('snapshot-restore');
                            },
                            child: const Text('恢复'),
                          ),
                        ),
                    ],
                  ),
          ),
          actions: [
            TextButton(
              onPressed: () async {
                await app.client.post('/api/snapshots');
                if (ctx.mounted) Navigator.pop(ctx);
                messenger.showSnackBar(const SnackBar(content: Text('快照已创建')));
              },
              child: const Text('创建快照'),
            ),
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭')),
          ],
        ),
      );
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('加载快照失败：$e')));
    }
  }

  Future<void> _export(BuildContext context, AppController app, String path, String filename) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final resp = await app.client.getBytes(path);
      messenger.showSnackBar(SnackBar(
        content: Text('已下载 ${resp.body.length} 字节（$filename）— 请在服务器管理页下载完整导出'),
      ));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('导出失败：$e')));
    }
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text(
        text,
        style: TextStyle(
          color: MdTheme.of(context).primary,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
