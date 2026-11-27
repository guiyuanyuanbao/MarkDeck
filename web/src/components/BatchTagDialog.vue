<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { errMsg } from '@/utils/ui'
import { bookmarksApi } from '@/api/client'

const visible = ref(false)
const loading = ref(false)
const emit = defineEmits<{ done: [] }>()
const tagInput = ref('')
const pendingIds = ref<string[]>([])

function open(ids: string[]) {
  pendingIds.value = ids
  tagInput.value = ''
  visible.value = true
}

async function confirm() {
  const tags = tagInput.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
  if (!tags.length) { ElMessage.warning('请输入至少一个标签'); return }
  loading.value = true
  try {
    for (const tag of tags) {
      await bookmarksApi.batch({ ids: pendingIds.value, action: 'tag', tag })
    }
    ElMessage.success('标签已添加')
    visible.value = false
    emit('done')
  } catch (e) {
    ElMessage.error(errMsg(e))
  } finally {
    loading.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <el-dialog v-model="visible" title="添加标签" width="420px">
    <el-input v-model="tagInput" placeholder="输入标签，逗号分隔多个，如: 开发, 文档" size="large" @keyup.enter="confirm" />
    <div style="color: var(--md-text-3); font-size: 12px; margin-top: 8px">
      将为选中的 {{ pendingIds.length }} 项添加标签
    </div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="loading" @click="confirm">添加</el-button>
    </template>
  </el-dialog>
</template>
