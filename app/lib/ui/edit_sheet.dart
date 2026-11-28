import 'dart:convert';

import 'package:drift/drift.dart' hide Column;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import '../store/database.dart';

String tagsToJson(List<String> tags) => jsonEncode(tags);

List<String> tagsFromJson(String j) => (jsonDecode(j) as List).cast<String>();

/// Bottom-sheet editor for creating/editing a bookmark or folder. Writes
/// the mirror immediately + journals the touch so the next reconcile
/// pushes it with the right LWW clock.
Future<void> showEditSheet(
  BuildContext context,
  AppDatabase db, {
  Node? existing,
  String parentId = '',
  String presetTitle = '',
  String presetUrl = '',
}) async {
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => _EditSheet(
      db: db,
      existing: existing,
      parentId: parentId,
      presetTitle: presetTitle,
      presetUrl: presetUrl,
    ),
  );
}

class _EditSheet extends StatefulWidget {
  const _EditSheet({
    required this.db,
    this.existing,
    required this.parentId,
    this.presetTitle = '',
    this.presetUrl = '',
  });

  final AppDatabase db;
  final Node? existing;
  final String parentId;
  final String presetTitle;
  final String presetUrl;

  @override
  State<_EditSheet> createState() => _EditSheetState();
}

class _EditSheetState extends State<_EditSheet> {
  late final TextEditingController _title;
  late final TextEditingController _url;
  late final TextEditingController _note;
  late List<String> _tags;
  bool _favorite = false;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _title = TextEditingController(text: e?.title ?? widget.presetTitle);
    _url = TextEditingController(text: e?.url ?? widget.presetUrl);
    _note = TextEditingController(text: e?.note ?? '');
    _tags = e == null ? [] : tagsFromJson(e.tags);
    _favorite = e?.favorite ?? false;
  }

  bool get _isFolder => widget.existing?.type == 'folder';
  bool get _isUrl => widget.existing == null || widget.existing!.type == 'url';

  Future<void> _save() async {
    final title = _title.text.trim();
    if (title.isEmpty) return;
    final e = widget.existing;
    final controller = Provider.of<AppController>(context, listen: false);
    if (e == null) {
      // create: mint a client-side id — the server accepts client-chosen ids
      final id = '${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-${title.hashCode.toRadixString(36)}';
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      await widget.db.into(widget.db.nodes).insert(NodesCompanion.insert(
            id: id,
            parentId: Value(widget.parentId),
            type: _isUrl ? 'url' : 'folder',
            title: title,
            url: Value(_isUrl ? _url.text.trim() : null),
            note: Value(_note.text.trim()),
            favorite: Value(_favorite),
            position: Value(await _nextPosition(widget.parentId)),
            createdAt: Value(now),
            updatedAt: Value(now),
            tags: Value(jsonEncode(_tags)),
          ));
      await controller.driver.journalTouch(
        id,
        title: title,
        url: _isUrl ? _url.text.trim() : null,
        tags: _tags.isEmpty ? null : _tags,
      );
    } else {
      await (widget.db.update(widget.db.nodes)..where((r) => r.id.equals(e.id))).write(
        NodesCompanion(
          url: _isUrl ? Value(_url.text.trim()) : const Value.absent(),
          note: Value(_note.text.trim()),
          favorite: Value(_favorite),
          tags: Value(jsonEncode(_tags)),
        ),
      );
      await controller.driver.journalTouch(
        e.id,
        title: title,
        url: _isUrl ? _url.text.trim() : null,
        tags: _tags.isEmpty ? null : _tags,
      );
    }
    if (mounted) Navigator.of(context).pop();
  }

  Future<double> _nextPosition(String parentId) async {
    final sibs = await (widget.db.select(widget.db.nodes)
          ..where((r) => r.parentId.equals(parentId)))
        .get();
    if (sibs.isEmpty) return 1.0;
    return sibs.map((s) => s.position).reduce((a, b) => a > b ? a : b) + 1.0;
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            widget.existing == null ? '新建' : '编辑',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _title,
            autofocus: true,
            decoration: const InputDecoration(labelText: '标题', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          if (!_isFolder) ...[
            TextField(
              controller: _url,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(labelText: 'URL', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 12),
          ],
          TextField(
            controller: _note,
            decoration: const InputDecoration(labelText: '备注（可选）', border: OutlineInputBorder()),
            maxLines: 2,
          ),
          const SizedBox(height: 12),
          TagsField(
            initial: _tags,
            onChanged: (tags) => _tags = tags,
          ),
          const SizedBox(height: 8),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('收藏'),
            value: _favorite,
            onChanged: (v) => setState(() => _favorite = v),
          ),
          const SizedBox(height: 8),
          FilledButton.icon(
            onPressed: _save,
            icon: const Icon(Icons.check),
            label: const Text('保存'),
          ),
        ],
      ),
    );
  }
}

/// Comma-separated tag input. Kept as its own widget so the parent's
/// _tags list updates on every change without re-creating the controller.
class TagsField extends StatefulWidget {
  const TagsField({super.key, required this.initial, required this.onChanged});

  final List<String> initial;
  final ValueChanged<List<String>> onChanged;

  @override
  State<TagsField> createState() => _TagsFieldState();
}

class _TagsFieldState extends State<TagsField> {
  late final TextEditingController _c;

  @override
  void initState() {
    super.initState();
    _c = TextEditingController(text: widget.initial.join(', '));
  }

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: _c,
      decoration: const InputDecoration(
        labelText: '标签（逗号分隔）',
        border: OutlineInputBorder(),
      ),
      onChanged: (v) => widget.onChanged(
        v.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toSet().toList(),
      ),
    );
  }
}

/// New-folder dialog: mint a client id and insert into the mirror.
Future<void> showCreateFolder(
  BuildContext context,
  AppDatabase db,
  String folderId,
) async {
  final c = TextEditingController();
  final name = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('新建文件夹'),
      content: TextField(
        controller: c,
        autofocus: true,
        decoration: const InputDecoration(labelText: '文件夹名'),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('创建')),
      ],
    ),
  );
  if (name == null || name.isEmpty) return;
  final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
  final id = '${now.toRadixString(36)}-f${name.hashCode.toRadixString(36)}';
  final parent = folderId == 'root' ? '' : folderId;
  final sibs = await (db.select(db.nodes)..where((r) => r.parentId.equals(parent))).get();
  var pos = 1.0;
  if (sibs.isNotEmpty) {
    pos = sibs.map((s) => s.position).reduce((a, b) => a > b ? a : b) + 1.0;
  }
  await db.into(db.nodes).insert(NodesCompanion.insert(
        id: id,
        parentId: Value(parent),
        type: 'folder',
        title: name,
        position: Value(pos),
        createdAt: Value(now),
        updatedAt: Value(now),
      ));
  if (!context.mounted) return;
  final controller = Provider.of<AppController>(context, listen: false);
  await controller.driver.journalTouch(id, title: name);
}
