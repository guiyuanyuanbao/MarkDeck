import 'dart:math' as math;

import 'package:drift/drift.dart' hide Column;
import 'package:flutter/material.dart';

import '../state/app_controller.dart';
import '../store/database.dart';
import 'theme.dart';
import 'widgets.dart';

/// 原地拖动排序共享件。排序模式不换页、不换布局：浏览页的列表行与
/// 网格卡片用这里的 [DragTarget]+[LongPressDraggable] 包装后即可拖动。
///
/// 落点分区（对齐 web bookmarkDnd）：
/// - 列表行：上/下半区 = 插到该行前/后；文件夹行中间带 = 移入
/// - 网格卡片：左 1/4 = 前、右 1/4 = 后、中间带 = 文件夹移入 / URL 前后对分
///
/// 镜像先行：位置/父节点在提交函数里重写（整桶 1..n / 桶尾），随后
/// journal 交出 LWW 凭证，由引擎 sweep 推 position-only ops
/// （docs/protocol.md §排序同步；R1 路径）。
enum DropZone { before, after, inside }

/// 拖拽会话状态：被拖项、悬停目标与落点分区；行几何经 per-id GlobalKey
/// 读取，自动滚动挂接浏览页的 ScrollController。
class DragOrderModel extends ChangeNotifier {
  final _rowKeys = <String, GlobalKey>{};
  ScrollController? scroll;

  String? dragId;
  String? hoverId;
  DropZone? hoverZone;

  GlobalKey keyFor(String id) => _rowKeys.putIfAbsent(id, () => GlobalKey());

  RenderBox? boxFor(String id) {
    final ctx = _rowKeys[id]?.currentContext;
    final box = ctx?.findRenderObject();
    return box is RenderBox && box.hasSize ? box : null;
  }

  void start(String id) {
    dragId = id;
    notifyListeners();
  }

  void track(Node target, Offset global,
      {required bool grid, required String othersId}) {
    final box = boxFor(target.id);
    if (box == null) return;
    final top = box.localToGlobal(Offset.zero).dy;
    final left = box.localToGlobal(Offset.zero).dx;
    final w = box.size.width;
    final h = box.size.height;
    final dx = (global.dx - left) / w;
    final dy = global.dy - top;
    DropZone zone;
    if (target.id == othersId) {
      // 其他书签是服务端管理的固定尾项：拖到它上面任何位置都是移入
      zone = DropZone.inside;
    } else if (!grid) {
      if (target.type == 'folder') {
        if (dy < h * 0.25) {
          zone = DropZone.before;
        } else if (dy > h * 0.75) {
          zone = DropZone.after;
        } else {
          zone = DropZone.inside;
        }
      } else {
        zone = dy < h / 2 ? DropZone.before : DropZone.after;
      }
    } else {
      if (dx < 0.25) {
        zone = DropZone.before;
      } else if (dx > 0.75) {
        zone = DropZone.after;
      } else if (target.type == 'folder') {
        zone = DropZone.inside;
      } else {
        zone = dx < 0.5 ? DropZone.before : DropZone.after;
      }
    }
    if (hoverId != target.id || hoverZone != zone) {
      hoverId = target.id;
      hoverZone = zone;
      notifyListeners();
    }
  }

  void clearHover(String id) {
    if (hoverId == id) {
      hoverId = null;
      hoverZone = null;
      notifyListeners();
    }
  }

  void end() {
    dragId = null;
    hoverId = null;
    hoverZone = null;
    notifyListeners();
  }

  /// 拖近列表上下边缘 64px 时渐进滚动，保证长列表/网格可达折叠项
  void autoScroll(Offset global) {
    if (scroll == null || !scroll!.hasClients) return;
    const edge = 64.0;
    const speed = 16.0;
    final pos = scroll!.position;
    final viewport = _viewportRect();
    if (viewport == null) return;
    if (global.dy < viewport.top + edge) {
      final t = 1 - (global.dy - viewport.top) / edge;
      scroll!.jumpTo(math.max(0.0, pos.pixels - speed * (0.3 + t)));
    } else if (global.dy > viewport.bottom - edge) {
      final t = 1 - (viewport.bottom - global.dy) / edge;
      scroll!.jumpTo(math.min(pos.maxScrollExtent, pos.pixels + speed * (0.3 + t)));
    }
  }

  Rect? _viewportRect() {
    final box = scroll?.position.context.storageContext.findRenderObject();
    return box is RenderBox && box.hasSize
        ? box.localToGlobal(Offset.zero) & box.size
        : null;
  }
}

/// 目标能否接收被拖项：不能是自己；文件夹目标不能在被拖项的子树内（环）
bool canAcceptDrop(List<Node> rows, String draggedId, Node target) {
  if (draggedId == target.id) return false;
  if (target.type != 'folder') return true;
  final byId = {for (final r in rows) r.id: r};
  String? cur = target.id;
  while (cur != null && cur.isNotEmpty) {
    if (cur == draggedId) return false;
    cur = byId[cur]?.parentId;
  }
  return true;
}

/// 同级插行：从纯位置序列摘出被拖项，插到目标前/后，整桶重写 1..n。
/// 序列须排除 md-others（固定尾项，位置由服务端管理，永不重写）。
Future<void> commitReorderInsert(AppController app, String folderId, List<Node> seq,
    String draggedId, String targetId,
    {required bool before}) async {
  final from = seq.indexWhere((r) => r.id == draggedId);
  if (from < 0) return;
  final dragged = seq.removeAt(from);
  var ti = seq.indexWhere((r) => r.id == targetId);
  if (ti < 0) return;
  seq.insert(before ? ti : ti + 1, dragged);
  for (var i = 0; i < seq.length; i++) {
    final pos = (i + 1).toDouble();
    if ((seq[i].position - pos).abs() < 1e-9) continue;
    await (app.db.update(app.db.nodes)..where((r) => r.id.equals(seq[i].id)))
        .write(NodesCompanion(position: Value(pos)));
  }
  await app.driver.journalTouch(draggedId);
  final bucketKey = folderId == 'root' ? 'root' : folderId;
  await app.driver.journalReorder(bucketKey);
}

/// 拖入文件夹：落到目标桶尾部（MaxPosition+1），改父 + 写位置 + journal
Future<void> commitMoveInto(
    AppController app, List<Node> rows, String draggedId, String targetFolderId) async {
  final siblings = rows
      .where((r) => r.parentId == targetFolderId && r.id != draggedId)
      .toList()
        ..sort((a, b) {
          final c = a.position.compareTo(b.position);
          return c != 0 ? c : a.createdAt.compareTo(b.createdAt);
        });
  final pos = siblings.isEmpty ? 1.0 : siblings.last.position + 1;
  await (app.db.update(app.db.nodes)..where((r) => r.id.equals(draggedId)))
      .write(NodesCompanion(
    parentId: Value(targetFolderId),
    position: Value(pos),
  ));
  await app.driver.journalTouch(draggedId);
}

/// 拖动时的浮起卡片（feedback）
Widget dragFeedback(BuildContext context, MdPalette p, Node n) {
  final width = math.min(MediaQuery.of(context).size.width - 48, 360.0);
  return Material(
    elevation: 6,
    borderRadius: BorderRadius.circular(12),
    color: p.surface,
    child: SizedBox(
      width: width,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(
          children: [
            SizedBox(
              width: 32,
              child: n.type == 'folder'
                  ? Icon(Icons.folder_rounded, size: 20, color: p.primary)
                  : BookmarkAvatar(url: n.url ?? '', title: n.title, size: 28),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(n.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: p.text)),
            ),
            const Icon(Icons.drag_indicator, size: 18, color: Colors.grey),
          ],
        ),
      ),
    ),
  );
}

Widget dropLine(MdPalette p, {bool vertical = false}) {
  if (vertical) {
    return Container(
      width: 2.5,
      margin: const EdgeInsets.symmetric(vertical: 8),
      color: p.primary,
    );
  }
  return Container(
    height: 2.5,
    margin: const EdgeInsets.symmetric(horizontal: 12),
    color: p.primary,
  );
}
