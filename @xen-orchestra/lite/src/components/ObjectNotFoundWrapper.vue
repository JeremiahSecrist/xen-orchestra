<template>
  <div v-if="!isReady" class="wrapper-spinner">
    <UiSpinner class="spinner" />
  </div>
  <ObjectNotFoundView v-else-if="isRecordNotFound" :id="id" />
  <slot v-else />
</template>

<script
  generic="T extends XenApiRecord<string>, I extends T['uuid']"
  lang="ts"
  setup
>
import UiSpinner from "@/components/ui/UiSpinner.vue";
import type { XenApiRecord } from "@/libs/xen-api";
import ObjectNotFoundView from "@/views/ObjectNotFoundView.vue";
import { computed } from "vue";
import { useRouter } from "vue-router";

const props = defineProps<{
  isReady: boolean;
  uuidChecker: (uuid: I) => boolean;
  id?: I;
}>();

const { currentRoute } = useRouter();

const id = computed(() => props.id ?? (currentRoute.value.params.uuid as I));

const isRecordNotFound = computed(
  () => props.isReady && !props.uuidChecker(id.value)
);
</script>

<style scoped>
.wrapper-spinner {
  display: flex;
  height: 100%;
}

.spinner {
  color: var(--color-extra-blue-base);
  display: flex;
  margin: auto;
  width: 10rem;
  height: 10rem;
}
</style>
