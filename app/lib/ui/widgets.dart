import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import 'theme.dart';

/// BookmarkAvatar parity (web/src/components/BookmarkAvatar.vue): favicon
/// from /api/favicon/{host} with a per-host letter-gradient fallback picked
/// by hash(url|title). List rows and grid cards render identically.
class BookmarkAvatar extends StatefulWidget {
  const BookmarkAvatar({super.key, required this.url, required this.title, this.size = 22});

  final String url;
  final String title;
  final double size;

  @override
  State<BookmarkAvatar> createState() => _BookmarkAvatarState();
}

class _BookmarkAvatarState extends State<BookmarkAvatar> {
  static final _failed = <String>{};

  String? get _host {
    if (widget.url.isEmpty) return null;
    try {
      final h = Uri.parse(widget.url).host;
      return h.isEmpty ? null : h;
    } on FormatException {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final host = _host;
    final size = widget.size;
    if (host == null || _failed.contains(host)) {
      // letter gradient fallback
      final colors = MdTheme.avatarColors(widget.url, widget.title);
      final letter = (widget.title.isNotEmpty ? widget.title[0] : '?').toUpperCase();
      return Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: colors,
          ),
          borderRadius: BorderRadius.circular(size * 0.3),
        ),
        alignment: Alignment.center,
        child: Text(
          letter,
          style: TextStyle(
            color: Colors.white,
            fontSize: size * 0.45,
            fontWeight: FontWeight.w700,
          ),
        ),
      );
    }
    final server = context.read<AppController>().serverUrl ?? '';
    return ClipRRect(
      borderRadius: BorderRadius.circular(size * 0.3),
      child: Image.network(
        '$server/api/favicon/$host',
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) {
          _failed.add(host);
          // schedule rebuild to show the fallback
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) setState(() {});
          });
          return SizedBox(width: size, height: size);
        },
      ),
    );
  }
}

/// Shared UI helpers kept from v1: folder picker + tag prompt + codecs.

/// Folder picker dialog: walk the mirror tree, return the picked folder id
/// ('root' = bar bucket) or null when cancelled.
Future<String?> pickFolder(
  BuildContext context,
  dynamic db, {
  Set<String> excludeIds = const {},
}) async {
  return showDialog<String>(
    context: context,
    builder: (ctx) => _FolderPicker(db: db, excludeIds: excludeIds),
  );
}

class _FolderPicker extends StatefulWidget {
  const _FolderPicker({required this.db, required this.excludeIds});

  final dynamic db;
  final Set<String> excludeIds;

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
        child: StreamBuilder(
          stream: widget.db.watchAllLive(),
          builder: (context, snap) {
            final rows = (snap.data as List?) ?? const [];
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
                      final parent =
                          rows.where((r) => r.id == _current).firstOrNull;
                      _current = parent == null
                          ? 'root'
                          : (parent.parentId.isEmpty ? 'root' : parent.parentId);
                    }),
                  ),
                for (final f in folders)
                  if (!widget.excludeIds.contains(f.id))
                    ListTile(
                      leading: Icon(Icons.folder_outlined, color: MdTheme.of(context).primary),
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
        FilledButton(
            onPressed: () => Navigator.pop(context, _current), child: const Text('移到这里')),
      ],
    );
  }
}

/// Tag input prompt: comma-separated, trimmed, deduped. Null on cancel.
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
                .map((t) => t.trim())
                .where((t) => t.isNotEmpty)
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
