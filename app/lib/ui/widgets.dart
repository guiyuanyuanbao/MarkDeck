import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import '../store/database.dart';

/// Shared UI helpers: folder picker, tag prompt, favicon widget, tag codec.

/// Folder picker dialog: walk the mirror tree, return the picked folder id
/// ('root' = bar bucket) or null when cancelled.
Future<String?> pickFolder(
  BuildContext context,
  AppDatabase db, {
  Set<String> excludeIds = const {},
}) async {
  final controller = Provider.of<AppController>(context, listen: false);
  return showDialog<String>(
    context: context,
    builder: (ctx) => _FolderPicker(db: db, excludeIds: excludeIds, controller: controller),
  );
}

class _FolderPicker extends StatefulWidget {
  const _FolderPicker({required this.db, required this.excludeIds, required this.controller});

  final AppDatabase db;
  final Set<String> excludeIds;
  final AppController controller;

  @override
  State<_FolderPicker> createState() => _FolderPickerState();
}

class _FolderPickerState extends State<_FolderPicker> {
  String _current = 'root';

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('移动到…'),
      content: SizedBox(
        width: 280,
        height: 320,
        child: StreamBuilder<List<Node>>(
          stream: widget.db.watchAllLive(),
          builder: (context, snap) {
            final rows = snap.data ?? const <Node>[];
            final serverParent = _current == 'root' ? '' : _current;
            final folders = rows
                .where((r) => r.type == 'folder' && r.parentId == serverParent)
                .toList()
              ..sort((a, b) => a.position.compareTo(b.position));
            return ListView(
              children: [
                if (_current != 'root')
                  ListTile(
                    leading: const Icon(Icons.arrow_upward),
                    title: const Text('上一级'),
                    onTap: () => setState(() {
                      final parent = rows.where((r) => r.id == _current).firstOrNull;
                      _current = parent == null ? 'root' : (parent.parentId.isEmpty ? 'root' : parent.parentId);
                    }),
                  ),
                for (final f in folders)
                  if (!widget.excludeIds.contains(f.id))
                    ListTile(
                      leading: const Icon(Icons.folder_outlined),
                      title: Text(f.title),
                      onTap: () => setState(() => _current = f.id),
                    ),
              ],
            );
          },
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, _current), child: const Text('移到这里')),
      ],
    );
  }
}

/// Tag input prompt: comma-separated, trimmed, deduped. Returns null on cancel.
Future<List<String>?> promptTags(BuildContext context) async {
  final controller = TextEditingController();
  final result = await showDialog<List<String>>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('标签'),
      content: TextField(
        controller: controller,
        autofocus: true,
        decoration: const InputDecoration(
          labelText: '逗号分隔，如: 工作, 文档',
          border: OutlineInputBorder(),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        FilledButton(
          onPressed: () {
            final tags = controller.text
                .split(',')
                .map((s) => s.trim())
                .where((s) => s.isNotEmpty)
                .toSet()
                .toList();
            Navigator.pop(ctx, tags);
          },
          child: const Text('确定'),
        ),
      ],
    ),
  );
  return result;
}

/// Favicon tile backed by GET /api/favicon/{host} (public route) with an
/// in-memory LRU so lists don't re-fetch every build.
class Favicon extends StatefulWidget {
  const Favicon({super.key, required this.host, this.size = 40});

  final String host;
  final double size;

  @override
  State<Favicon> createState() => _FaviconState();
}

class _FaviconState extends State<Favicon> {
  static final _cache = <String, ImageProvider<Object>>{};

  @override
  Widget build(BuildContext context) {
    final host = widget.host;
    if (host.isEmpty) {
      return SizedBox(
        width: widget.size,
        height: widget.size,
        child: const Icon(Icons.public_outlined),
      );
    }
    var provider = _cache[host];
    if (provider == null) {
      final server = context.read<AppController>().serverUrl ?? '';
      provider = NetworkImage('$server/api/favicon/$host');
      _cache[host] = provider;
    }
    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: Image(image: provider, fit: BoxFit.cover,
          errorBuilder: (context, error, stackTrace) =>
              const Icon(Icons.public_outlined),
        ),
      ),
    );
  }
}
