import 'package:drift/drift.dart' hide Column;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../state/app_controller.dart';
import '../store/database.dart';
import 'edit_sheet.dart';
import 'widgets.dart';

/// Bookmarks browser: folder tree with breadcrumbs, selection mode with
/// batch actions, per-row menu (edit/move/delete), favicons. All reads run
/// on drift streams → offline-capable.
class BrowseScreen extends StatefulWidget {
  const BrowseScreen({super.key});

  @override
  State<BrowseScreen> createState() => _BrowseScreenState();
}

class _BrowseScreenState extends State<BrowseScreen> {
  String _folderId = 'root'; // synthetic bar root in the mirror
  final _selected = <String>{};
  bool _selecting = false;

  AppController get _app => context.read<AppController>();
  AppDatabase get _db => _app.db;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: Text(_selecting ? '已选 ${_selected.length} 项' : '书签'),
        actions: [
          if (_selecting) ...[
            IconButton(icon: const Icon(Icons.drive_file_move_outline), tooltip: '移动到…', onPressed: _selected.isEmpty ? null : _batchMove),
            IconButton(icon: const Icon(Icons.label_outline), tooltip: '打标签', onPressed: _selected.isEmpty ? null : _batchTag),
            IconButton(icon: const Icon(Icons.delete_outline), tooltip: '删除', onPressed: _selected.isEmpty ? null : _batchDelete),
            TextButton(onPressed: _exitSelect, child: const Text('取消')),
          ] else
            IconButton(icon: const Icon(Icons.add), tooltip: '新建书签', onPressed: () => showEditSheet(context, _db, parentId: _folderId == 'root' ? '' : _folderId)),
        ],
      ),
      body: StreamBuilder<List<Node>>(
        stream: _db.watchAllLive(),
        builder: (context, snap) {
          final rows = snap.data ?? const <Node>[];
          final children = _childrenOf(rows, _folderId);
          return Column(
            children: [
              _breadcrumb(scheme),
              if (snap.hasData)
                Expanded(
                  child: children.isEmpty
                      ? Center(
                          child: Text(
                            _folderId == 'root' ? '书签栏为空\n桌面端书签将自动同步到这里' : '空文件夹',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: scheme.outline),
                          ),
                        )
                      : ListView.builder(
                          itemCount: children.length,
                          itemBuilder: (context, i) => _row(children[i]),
                        ),
                )
              else
                const Expanded(child: Center(child: CircularProgressIndicator())),
            ],
          );
        },
      ),
    );
  }

  // ---- tree helpers ----

  List<Node> _childrenOf(List<Node> rows, String folderId) {
    final serverParent = folderId == 'root' ? '' : folderId;
    final kids = rows.where((r) => r.parentId == serverParent).toList()
      ..sort((a, b) {
        final c = a.position.compareTo(b.position);
        return c != 0 ? c : a.createdAt.compareTo(b.createdAt);
      });
    return kids;
  }

  Widget _breadcrumb(ColorScheme scheme) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      color: scheme.surfaceContainerHighest,
      child: Row(
        children: [
          InkWell(
            onTap: () => setState(() { _folderId = 'root'; _exitSelect(); }),
            child: const Text('书签栏'),
          ),
          if (_folderId != 'root') ...[
            const Text(' / '),
            StreamBuilder<List<Node>>(
              stream: _db.watchAllLive(),
              builder: (context, snap) {
                final rows = snap.data ?? const <Node>[];
                final chain = <String>[];
                var cur = rows.where((r) => r.id == _folderId).firstOrNull;
                while (cur != null) {
                  chain.insert(0, cur.title);
                  cur = rows.where((r) => r.id == cur!.parentId).firstOrNull;
                }
                return Expanded(
                  child: Text(
                    chain.join(' / '),
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: scheme.primary),
                  ),
                );
              },
            ),
          ],
        ],
      ),
    );
  }

  // ---- rows ----

  Widget _row(Node n) {
    final scheme = Theme.of(context).colorScheme;
    final isFolder = n.type == 'folder';
    final selected = _selected.contains(n.id);
    return ListTile(
      leading: _selecting
          ? Checkbox(
              value: selected,
              onChanged: (_) => _toggle(n.id),
            )
          : (isFolder
              ? Icon(Icons.folder_outlined, color: scheme.primary)
              : Favicon(host: _hostOf(n.url))),
      title: Text(n.title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: isFolder
          ? null
          : Text(n.url ?? '', maxLines: 1, overflow: TextOverflow.ellipsis),
      trailing: _selecting
          ? null
          : PopupMenuButton<String>(
              onSelected: (v) => _rowAction(v, n),
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'open', child: Text('打开')),
                PopupMenuItem(value: 'edit', child: Text('编辑')),
                PopupMenuItem(value: 'delete', child: Text('删除')),
              ],
            ),
      onTap: () {
        if (_selecting) {
          _toggle(n.id);
        } else if (isFolder) {
          setState(() => _folderId = n.id);
        } else {
          _open(n.url);
        }
      },
      onLongPress: () {
        setState(() {
          _selecting = true;
          _selected.add(n.id);
        });
      },
    );
  }

  String _hostOf(String? url) {
    if (url == null) return '';
    try {
      return Uri.parse(url).host;
    } on FormatException {
      return '';
    }
  }

  void _toggle(String id) {
    setState(() {
      if (!_selected.remove(id)) _selected.add(id);
      if (_selected.isEmpty) _selecting = false;
    });
  }

  void _exitSelect() {
    setState(() {
      _selecting = false;
      _selected.clear();
    });
  }

  Future<void> _open(String? url) async {
    if (url == null || url.isEmpty) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    // jump to the DEFAULT browser (externalApplication, never in-app webview)
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  Future<void> _rowAction(String action, Node n) async {
    switch (action) {
      case 'open':
        await _open(n.url);
      case 'edit':
        await showEditSheet(context, _db, existing: n);
      case 'delete':
        await _app.driver.journalTouch(n.id, removed: true);
        await (_db.delete(_db.nodes)..where((r) => r.id.equals(n.id))).go();
    }
  }

  // ---- batch actions (touch-screen replacement for drag-and-drop) ----

  Future<void> _batchDelete() async {
    final ids = _selected.toList();
    for (final id in ids) {
      await _app.driver.journalTouch(id, removed: true);
    }
    await (_db.delete(_db.nodes)..where((r) => r.id.isIn(ids))).go();
    _exitSelect();
  }

  Future<void> _batchMove() async {
    final target = await pickFolder(context, _db, excludeIds: _selected);
    if (target == null) return;
    final serverParent = target == 'root' ? '' : target;
    for (final id in _selected) {
      await (_db.update(_db.nodes)..where((r) => r.id.equals(id)))
          .write(NodesCompanion(parentId: Value(serverParent)));
      await _app.driver.journalTouch(id);
    }
    _exitSelect();
  }

  Future<void> _batchTag() async {
    final tags = await promptTags(context);
    if (tags == null) return;
    for (final id in _selected) {
      await (_db.update(_db.nodes)..where((r) => r.id.equals(id)))
          .write(NodesCompanion(tags: Value(tagsToJson(tags))));
      await _app.driver.journalTouch(id, tags: tags);
    }
    _exitSelect();
  }
}
