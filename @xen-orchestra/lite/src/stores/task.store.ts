import useArrayRemovedItemsHistory from "@/composables/array-removed-items-history.composable";
import useCollectionFilter from "@/composables/collection-filter.composable";
import useCollectionSorter from "@/composables/collection-sorter.composable";
import useFilteredCollection from "@/composables/filtered-collection.composable";
import useSortedCollection from "@/composables/sorted-collection.composable";
import type { XenApiTask } from "@/libs/xen-api";
import { useXapiCollectionStore } from "@/stores/xapi-collection.store";
import { defineStore } from "pinia";

export const useTaskStore = defineStore("task", () => {
  const tasksCollection = useXapiCollectionStore().get("task");

  const subscribe = () => {
    const subscription = tasksCollection.subscribe();

    const { compareFn } = useCollectionSorter<XenApiTask>({
      initialSorts: ["-created"],
    });

    const sortedTasks = useSortedCollection(subscription.records, compareFn);

    const { predicate } = useCollectionFilter({
      initialFilters: [
        "!name_label:|(SR.scan host.call_plugin)",
        "status:pending",
      ],
    });

    const pendingTasks = useFilteredCollection<XenApiTask>(
      sortedTasks,
      predicate
    );

    const finishedTasks = useArrayRemovedItemsHistory(
      sortedTasks,
      (task) => task.uuid,
      {
        limit: 50,
        onRemove: (tasks) =>
          tasks.map((task) => ({
            ...task,
            finished: new Date().toISOString(),
          })),
      }
    );

    return {
      ...subscription,
      pendingTasks,
      finishedTasks,
    };
  };

  return { ...tasksCollection, subscribe };
});
