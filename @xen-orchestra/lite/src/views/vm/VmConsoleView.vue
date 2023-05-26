<template>
  <div class="vm-console-view">
    <UiSpinner v-if="!isReady" class="spinner" />
    <div v-else-if="!isVmRunning" class="not-running">
      <div><img alt="" src="@/assets/monitor.svg" /></div>
      {{ $t("power-on-for-console") }}
    </div>
    <RemoteConsole
      v-else-if="vm && vmConsole"
      :is-console-available="!isOperationsPending(vm, STOP_OPERATIONS)"
      :location="vmConsole.location"
      class="remote-console"
    />
  </div>
</template>

<script lang="ts" setup>
import RemoteConsole from "@/components/RemoteConsole.vue";
import UiSpinner from "@/components/ui/UiSpinner.vue";
import { isOperationsPending } from "@/libs/utils";
import { useConsoleStore } from "@/stores/console.store";
import { useVmStore } from "@/stores/vm.store";
import { computed } from "vue";
import { useRoute } from "vue-router";

const STOP_OPERATIONS = [
  "shutdown",
  "clean_shutdown",
  "hard_shutdown",
  "clean_reboot",
  "hard_reboot",
  "pause",
  "suspend",
];

const route = useRoute();

const { isReady: isVmReady, getByUuid: getVmByUuid } = useVmStore().subscribe();

const { isReady: isConsoleReady, getByOpaqueRef: getConsoleByOpaqueRef } =
  useConsoleStore().subscribe();

const isReady = computed(() => isVmReady.value && isConsoleReady.value);

const vm = computed(() => getVmByUuid(route.params.uuid as string));

const isVmRunning = computed(() => vm.value?.power_state === "Running");

const vmConsole = computed(() => {
  const consoleOpaqueRef = vm.value?.consoles[0];

  if (consoleOpaqueRef === undefined) {
    return;
  }

  return getConsoleByOpaqueRef(consoleOpaqueRef);
});
</script>

<style lang="postcss" scoped>
.vm-console-view {
  display: flex;
  align-items: center;
  justify-content: center;
  height: calc(100% - 14.5rem);
}

.spinner {
  color: var(--color-extra-blue-base);
  display: flex;
  margin: auto;
  width: 10rem;
  height: 10rem;
}

.remote-console {
  flex: 1;
  max-width: 100%;
  height: 100%;
}

.not-running {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  text-align: center;
  gap: 4rem;
  color: var(--color-extra-blue-base);
  font-size: 3.6rem;
}
</style>
