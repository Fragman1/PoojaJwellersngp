"use client";

import { useEffect, useState } from "react";
import { collection, getCountFromServer, getDocs } from "firebase/firestore";
import { getMetadata, listAll, ref as storageRef, deleteObject } from "firebase/storage";
import { db, storage } from "@/lib/firebase";

interface StorageSummary {
  collectionsBytes: number;
  collectionsFiles: number;
  reelsBytes: number;
  reelsFiles: number;
  orphanedFiles: number;
  orphanedBytes: number;
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function getFolderUsage(path: string): Promise<{ bytes: number; files: number; items: { fullPath: string; url: string; size: number }[] }> {
  const folder = storageRef(storage, path);
  const listing = await listAll(folder);
  const nestedResults = await Promise.all(listing.prefixes.map((prefix) => getFolderUsage(prefix.fullPath)));
  const metadata = await Promise.all(
    listing.items.map(async (item) => {
      const meta = await getMetadata(item);
      return { fullPath: item.fullPath, url: meta.downloadTokens ? `https://firebasestorage.googleapis.com/v0/b/${meta.bucket}/o/${encodeURIComponent(meta.fullPath)}?alt=media` : "", size: meta.size || 0 };
    })
  );

  return {
    bytes: metadata.reduce((s, i) => s + i.size, 0) + nestedResults.reduce((s, r) => s + r.bytes, 0),
    files: metadata.length + nestedResults.reduce((s, r) => s + r.files, 0),
    items: [...metadata, ...nestedResults.flatMap((r) => r.items)],
  };
}

export default function DashboardPage() {
  const [counts, setCounts] = useState({ collections: "-", reviews: "-", reels: "-" });
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null);
  const [storageError, setStorageError] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [cleanMsg, setCleanMsg] = useState("");

  async function loadDashboardData() {
    try {
      // Fetch Firestore counts + active image URLs
      const [collectionsSnap, reviewsCount, reelsSnap, collectionsUsage, reelsUsage] = await Promise.all([
        getDocs(collection(db, "collections")),
        getCountFromServer(collection(db, "reviews")),
        getDocs(collection(db, "reels")),
        getFolderUsage("collections").catch(() => ({ bytes: 0, files: 0, items: [] })),
        getFolderUsage("reels").catch(() => ({ bytes: 0, files: 0, items: [] })),
      ]);

      // Build set of active storage paths from Firestore docs
      const activeUrls = new Set<string>();
      collectionsSnap.docs.forEach((d) => {
        const url: string = d.data().image_url || "";
        if (url) activeUrls.add(decodeURIComponent(url.split("/o/")[1]?.split("?")[0] || ""));
      });
      reelsSnap.docs.forEach((d) => {
        const url: string = d.data().video_url || "";
        if (url) activeUrls.add(decodeURIComponent(url.split("/o/")[1]?.split("?")[0] || ""));
      });

      // Find orphaned files
      const allStorageItems = [...collectionsUsage.items, ...reelsUsage.items];
      const orphaned = allStorageItems.filter((item) => !activeUrls.has(item.fullPath));

      // Active files only
      const activeCollectionItems = collectionsUsage.items.filter((i) => activeUrls.has(i.fullPath));
      const activeReelItems = reelsUsage.items.filter((i) => activeUrls.has(i.fullPath));

      setCounts({
        collections: String(collectionsSnap.size),
        reviews: String(reviewsCount.data().count),
        reels: String(reelsSnap.size),
      });

      setStorageSummary({
        collectionsBytes: activeCollectionItems.reduce((s, i) => s + i.size, 0),
        collectionsFiles: activeCollectionItems.length,
        reelsBytes: activeReelItems.reduce((s, i) => s + i.size, 0),
        reelsFiles: activeReelItems.length,
        orphanedFiles: orphaned.length,
        orphanedBytes: orphaned.reduce((s, i) => s + i.size, 0),
      });
    } catch {
      setStorageError("Unable to load Firebase usage right now.");
    }
  }

  useEffect(() => { loadDashboardData(); }, []);

  async function handleCleanup() {
    if (!storageSummary || storageSummary.orphanedFiles === 0) return;
    setCleaning(true);
    setCleanMsg("");
    try {
      // Re-fetch to get orphaned file paths
      const [collectionsSnap, reelsSnap, collectionsUsage, reelsUsage] = await Promise.all([
        getDocs(collection(db, "collections")),
        getDocs(collection(db, "reels")),
        getFolderUsage("collections"),
        getFolderUsage("reels"),
      ]);

      const activeUrls = new Set<string>();
      collectionsSnap.docs.forEach((d) => {
        const url: string = d.data().image_url || "";
        if (url) activeUrls.add(decodeURIComponent(url.split("/o/")[1]?.split("?")[0] || ""));
      });
      reelsSnap.docs.forEach((d) => {
        const url: string = d.data().video_url || "";
        if (url) activeUrls.add(decodeURIComponent(url.split("/o/")[1]?.split("?")[0] || ""));
      });

      const allItems = [...collectionsUsage.items, ...reelsUsage.items];
      const orphaned = allItems.filter((item) => !activeUrls.has(item.fullPath));

      await Promise.all(orphaned.map((item) => deleteObject(storageRef(storage, item.fullPath))));

      setCleanMsg(`Deleted ${orphaned.length} orphaned file${orphaned.length === 1 ? "" : "s"}, freed ${formatBytes(orphaned.reduce((s, i) => s + i.size, 0))}`);
      await loadDashboardData();
    } catch {
      setCleanMsg("Cleanup failed. Please try again.");
    } finally {
      setCleaning(false);
    }
  }

  const stats = [
    { label: "Jewellery Items", value: counts.collections },
    { label: "Customer Reviews", value: counts.reviews },
    { label: "Video Reels", value: counts.reels },
  ];

  const totalStorageBytes = (storageSummary?.collectionsBytes || 0) + (storageSummary?.reelsBytes || 0);

  const usageCards = [
    {
      label: "Catalog Storage",
      value: storageSummary ? formatBytes(storageSummary.collectionsBytes) : "-",
      meta: storageSummary ? `${storageSummary.collectionsFiles} file${storageSummary.collectionsFiles === 1 ? "" : "s"}` : "Loading...",
    },
    {
      label: "Reels Storage",
      value: storageSummary ? formatBytes(storageSummary.reelsBytes) : "-",
      meta: storageSummary ? `${storageSummary.reelsFiles} file${storageSummary.reelsFiles === 1 ? "" : "s"}` : "Loading...",
    },
  ];

  return (
    <div className="py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Dashboard</h2>
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-3">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="flex h-32 flex-col justify-between rounded-2xl border border-gray-100 bg-white p-5 shadow-sm transition-all hover:shadow-md"
          >
            <div className="mt-auto text-3xl font-semibold text-gray-900 sm:text-4xl">{stat.value}</div>
            <div className="mt-1 text-xs font-medium text-gray-400">{stat.label}</div>
          </div>
        ))}
      </div>

      <section className="rounded-[2rem] border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900 sm:text-lg">Firebase Usage</h3>
            <p className="mt-1 text-xs text-gray-500">Storage used by active catalog images and reel videos.</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-gray-50 px-3 py-2 text-right">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-gray-400">Total</p>
            <p className="mt-1 text-xl font-semibold text-black sm:text-2xl">
              {storageSummary ? formatBytes(totalStorageBytes) : "..."}
            </p>
          </div>
        </div>

        {storageError ? (
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
            {storageError}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {usageCards.map((card) => (
                <div key={card.label} className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-gray-400">{card.label}</p>
                  <p className="mt-2 text-2xl font-semibold text-gray-900">{card.value}</p>
                  <p className="mt-1 text-xs text-gray-500">{card.meta}</p>
                </div>
              ))}
            </div>

            {/* Orphaned files cleanup */}
            {storageSummary && storageSummary.orphanedFiles > 0 && (
              <div className="mt-3 flex items-center justify-between rounded-2xl border border-orange-100 bg-orange-50 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-orange-800">
                    {storageSummary.orphanedFiles} orphaned file{storageSummary.orphanedFiles === 1 ? "" : "s"} found
                  </p>
                  <p className="text-xs text-orange-600">
                    {formatBytes(storageSummary.orphanedBytes)} from deleted items still in storage
                  </p>
                </div>
                <button
                  onClick={handleCleanup}
                  disabled={cleaning}
                  className="ml-4 shrink-0 rounded-xl bg-orange-600 px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-80 disabled:opacity-50"
                >
                  {cleaning ? "Cleaning..." : "Clean Up"}
                </button>
              </div>
            )}

            {cleanMsg && (
              <p className="mt-2 text-xs text-gray-500">{cleanMsg}</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
