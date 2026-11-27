import 'package:drift/drift.dart' hide Column;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import '../store/database.dart';
import 'edit_sheet.dart' show tagsFromJson, tagsToJson;

/// Tag management: counts, rename (merge = rename onto an existing name),
/// delete. Server-side ops via the admin session? No — /api/tags/* accept
/// device tokens (requireAny), so the paired identity suffices.
class TagsScreen extends StatelessWidget {
  const TagsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final db = context.read<AppController>().db;
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('标签')),
      body: StreamBuilder<List<Node>>(
        stream: db.watchAllLive(),
        builder: (context, snap) {
          final counts = <String, int>{};
          for (final r in snap.data ?? const <Node>[]) {
            for (final t in tagsFromJson(r.tags)) {
              counts[t] = (counts[t] ?? 0) + 1;
            }
          }
          if (counts.isEmpty) {
            return Center(
              child: Text('还没有标签', style: TextStyle(color: scheme.outline)),
            );
          }
          final tags = counts.keys.toList()..sort();
          return ListView.builder(
            itemCount: tags.length,
            itemBuilder: (context, i) {
              final tag = tags[i];
              return ListTile(
                leading: Icon(Icons.label_outline, color: scheme.primary),
                title: Text(tag),
                trailing: Text('${counts[tag]}'),
                onTap: () => _rename(context, db, tag, counts.keys.toList()),
                onLongPress: () => _confirmDelete(context, db, tag),
              );
            },
          );
        },
      ),
    );
  }

  Future<void> _rename(BuildContext context, AppDatabase db, String oldName, List<String> existing) async {
    final c = TextEditingController(text: oldName);
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重命名标签'),
        content: TextField(
          controller: c,
          autofocus: true,
          decoration: const InputDecoration(labelText: '新名称（输入已有标签名即合并）'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('确定')),
        ],
      ),
    );
    if (result == null || result.isEmpty || result == oldName) return;
    if (!context.mounted) return;
    final controller = context.read<AppController>();
    // merge = rename onto an existing name: rewrite rows locally, push tag
    // updates through the touch journal; the server-side rename endpoint
    // (POST /api/tags/rename) is fired by the driver's batch channel — for
    // now rewrite rows via per-row update ops so tags propagate by LWW.
    final rows = await (db.select(db.nodes)..where((n) => n.tags.like('%"$oldName"%'))).get();
    for (final r in rows) {
      final tags = tagsFromJson(r.tags).map((t) => t == oldName ? result : t).toList();
      await (db.update(db.nodes)..where((n) => n.id.equals(r.id)))
          .write(NodesCompanion(tags: Value(tagsToJson(tags))));
      await controller.driver.journalTouch(r.id, tags: tags);
    }
  }

  Future<void> _confirmDelete(BuildContext context, AppDatabase db, String tag) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除标签'),
        content: Text('从所有书签移除标签「$tag」？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    if (!context.mounted) return;
    final controller = context.read<AppController>();
    final rows = await (db.select(db.nodes)..where((n) => n.tags.like('%"$tag"%'))).get();
    for (final r in rows) {
      final tags = tagsFromJson(r.tags).where((t) => t != tag).toList();
      await (db.update(db.nodes)..where((n) => n.id.equals(r.id)))
          .write(NodesCompanion(tags: Value(tagsToJson(tags))));
      await controller.driver.journalTouch(r.id, tags: tags);
    }
  }
}

