<script setup lang="ts">
import { ref, reactive, toRef, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'

const visible = ref(false)
const loading = ref(false)
const mode = ref<'create' | 'edit'>('create')
const emit = defineEmits<{ saved: [] }>()

const form = reactive({
  id: '',
  parentId: '',
  type: 'url' as 'url' | 'folder',
  title: '',
  url: '',
  note: '',
  tags: '' as string, // comma separated in the input
  favorite: false,
})
const isUrl = computed(() => form.type === 'url')
const noteRef = toRef(form, 'note')
const tagsRef = toRef(form, 'tags')
const parentRef = toRef(form, 'parentId')
const favRef = toRef(form, 'favorite')
const folders = ref<{ id: string; label: string }[]>([])

async function loadFolders() {
  const { nodes } = await bookmarksApi.tree()
  folders.value = [
    { id: '', label: '根目录' },
    ...nodes.filter((n) => n.type === 'folder').map((n) => ({ id: n.id, label: (n.title || '(未命名)') })),
  ]
}

async function openCreate(parentId: string, type: 'url' | 'folder') {
  mode.value = 'create'
  Object.assign(form, { id: '', parentId, type, title: '', url: '', note: '', tags: '', favorite: false })
  await loadFolders()
  visible.value = true
}

async function openEdit(b: Bookmark) {
  mode.value = 'edit'
  Object.assign(form, {
    id: b.id, parentId: b.parentId, type: b.type, title: b.title, url: b.url || '',
    note: b.note || '', tags: (b.tags || []).join(', '), favorite: b.favorite,
  })
  await loadFolders()
  visible.value = true
}

async function save() {
  if (form.type === 'url' && !form.url.trim()) {
    ElMessage.warning('URL 不能为空')
    return
  }
  loading.value = true
  try {
    const tags = form.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    if (mode.value === 'create') {
      // favorite must ride the create payload: the dialog shows the switch
      // for url creates, and dropping it silently discarded the user's pick
      await bookmarksApi.create({ type: form.type, parentId: form.parentId, title: form.title, url: form.url, note: form.note, tags, favorite: form.favorite })
    } else {
      await bookmarksApi.update(form.id, { title: form.title, url: form.url, note: form.note, favorite: form.favorite, tags })
      if (form.parentId !== undefined) {
        // parent change handled through move API when different
        const cur = await bookmarksApi.tree()
        const node = cur.nodes.find((n) => n.id === form.id)
        if (node && node.parentId !== form.parentId) {
          await bookmarksApi.move(form.id, form.parentId, 9999)
        }
      }
    }
    ElMessage.success('已保存')
    visible.value = false
    emit('saved')
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

defineExpose({ openCreate, openEdit })
</script>

<template>
  <el-dialog v-model="visible" :title="mode === 'create' ? (form.type === 'folder' ? '新建文件夹' : '新建书签') : '编辑'" width="520px">
    <el-form label-width="70px">
      <el-form-item label="类型" v-if="mode === 'create'">
        <el-radio-group v-model="form.type">
          <el-radio-button value="url">书签</el-radio-button>
          <el-radio-button value="folder">文件夹</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="标题">
        <el-input v-model="form.title" placeholder="显示名称" />
      </el-form-item>
      <el-form-item label="URL" v-if="form.type === 'url'">
        <el-input v-model="form.url" placeholder="https://…" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="noteRef" type="textarea" :rows="3" placeholder="备注说明（支持全文搜索）" />
      </el-form-item>
      <el-form-item label="标签">
        <el-input v-model="tagsRef" placeholder="逗号分隔，如: 开发, 工具" />
      </el-form-item>
      <el-form-item label="位置">
        <el-select v-model="parentRef" style="width: 100%">
          <el-option v-for="f in folders" :key="f.id" :label="f.label" :value="f.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="收藏" v-if="mode === 'edit' || isUrl">
        <el-switch v-model="favRef" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="loading" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>
