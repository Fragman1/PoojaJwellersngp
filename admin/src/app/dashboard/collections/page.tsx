"use client";

import { useState, useEffect, useRef, ChangeEvent } from "react";
import Image from "next/image";
import {
  collection, addDoc, getDocs, deleteDoc, doc, serverTimestamp, query, orderBy, updateDoc
} from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from "firebase/storage";
import { db, storage } from "@/lib/firebase";

interface JewelleryItem {
  id: string; caption: string; category: string; material?: string;
  image_url: string; is_top_6: boolean;
  created_at?: { toMillis?: () => number; seconds?: number } | null;
}

const MATERIAL_OPTIONS = ["Gold", "Silver", "Platinum"];
const DEFAULT_SUBCATEGORY_OPTIONS = ["Diamond", "Necklaces", "Pendants", "Earrings", "Bangles", "Rings", "Bracelets", "Other"];

function getCreatedAtValue(item: JewelleryItem) {
  if (item.created_at?.toMillis) {
    return item.created_at.toMillis();
  }

  if (typeof item.created_at?.seconds === "number") {
    return item.created_at.seconds * 1000;
  }

  return 0;
}

async function compressImage(file: File): Promise<File> {
  if (typeof window === "undefined" || !file.type.startsWith("image/")) {
    return file;
  }

  const imageUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new window.Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Unable to load image for compression."));
      img.src = imageUrl;
    });

    const maxDimension = 1600;
    const largestSide = Math.max(image.width, image.height);
    const scale = largestSide > maxDimension ? maxDimension / largestSide : 1;
    const targetWidth = Math.max(1, Math.round(image.width * scale));
    const targetHeight = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      return file;
    }

    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const outputType = file.type === "image/png" ? "image/png" : "image/webp";
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, outputType, 0.82);
    });

    if (!blob || blob.size >= file.size) {
      return file;
    }

    const fileExtension = outputType === "image/png" ? "png" : "webp";
    const baseName = file.name.replace(/\.[^.]+$/, "");

    return new File([blob], `${baseName}.${fileExtension}`, {
      type: outputType,
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

export default function CollectionsPage() {
  const [items, setItems] = useState<JewelleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(""); const [success, setSuccess] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [category, setCategory] = useState("Diamond");
  const [material, setMaterial] = useState("Gold");
  const [isTop6, setIsTop6] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [newCategoryInput, setNewCategoryInput] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCaption, setEditCaption] = useState("");
  const [editCategory, setEditCategory] = useState("Diamond");
  const [editMaterial, setEditMaterial] = useState("Gold");
  const [editIsTop6, setEditIsTop6] = useState(false);
  const [editCategoryInput, setEditCategoryInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<JewelleryItem | null>(null);
  const [top6PopupOpen, setTop6PopupOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [materialFilter, setMaterialFilter] = useState("All");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [firestoreSubcategories, setFirestoreSubcategories] = useState<string[]>([]);
  const [subcategoryDocs, setSubcategoryDocs] = useState<{ id: string; name: string; isDefault?: boolean }[]>([]);
  const [managingCategories, setManagingCategories] = useState(false);
  const [addingSubcat, setAddingSubcat] = useState(false);
  const [deletingSubcatId, setDeletingSubcatId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);


  const top6Count = items.filter((item) => item.is_top_6).length;

  function canMarkAsTop6(currentItemId?: string) {
    const featuredCountExcludingCurrent = items.filter(
      (item) => item.is_top_6 && item.id !== currentItemId,
    ).length;

    return featuredCountExcludingCurrent < 6;
  }

  function showTop6Popup() {
    setTop6PopupOpen(true);
  }

  const deletedDefaults = subcategoryDocs
    .filter(doc => doc.isDefault && (doc as any).deleted)
    .map(doc => doc.name.toLowerCase());

  const activeDefaults = DEFAULT_SUBCATEGORY_OPTIONS.filter(
    cat => !deletedDefaults.includes(cat.toLowerCase())
  );

  const categoryOptions = Array.from(
    new Set(
      [
        ...activeDefaults,
        ...firestoreSubcategories.filter(name => {
          const doc = subcategoryDocs.find(d => d.name === name);
          return !doc || (!(doc as any).deleted && !doc.isDefault);
        }),
        ...items.map((item) => item.category).filter(Boolean),
        category,
        editCategory,
      ].map((value) => value.trim()),
    ),
  ).filter(Boolean);

  async function fetchFirestoreSubcategories() {
    try {
      const snap = await getDocs(collection(db, "subcategories"));
      const docs = snap.docs.map((d) => ({ 
        id: d.id, 
        name: (d.data() as { name: string }).name,
        isDefault: (d.data() as { isDefault?: boolean }).isDefault || false
      }));
      setSubcategoryDocs(docs);
      setFirestoreSubcategories(docs.map((d) => d.name));
    } catch { /* ignore */ }
  }

  async function handleAddSubcategory(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    
    // Check against all categories including hidden defaults
    const allCategoryNames = [
      ...DEFAULT_SUBCATEGORY_OPTIONS,
      ...subcategoryDocs.map(d => d.name)
    ];
    
    const duplicate = allCategoryNames.some(
      (c) => c.toLowerCase() === trimmed.toLowerCase()
    );
    
    if (duplicate) {
      setError("This subcategory already exists.");
      setTimeout(() => setError(""), 3000);
      return;
    }
    
    setAddingSubcat(true);
    try {
      await addDoc(collection(db, "subcategories"), { 
        name: trimmed, 
        isDefault: false,
        created_at: serverTimestamp() 
      });
      await fetchFirestoreSubcategories();
      setNewCategoryInput("");
      setCategory(trimmed);
      setSuccess("Category added!");
      setTimeout(() => setSuccess(""), 2000);
    } catch { 
      setError("Failed to add category.");
      setTimeout(() => setError(""), 3000);
    }
    finally { setAddingSubcat(false); }
  }

  async function handleRestoreDefault(name: string) {
    try {
      // Check if there's already a custom category with this name
      const customWithSameName = subcategoryDocs.find(
        d => !d.isDefault && d.name.toLowerCase() === name.toLowerCase()
      );
      
      if (customWithSameName) {
        // Delete the custom one first, then restore the default
        await deleteDoc(doc(db, "subcategories", customWithSameName.id));
      }
      
      // Find and delete the "deleted" marker doc
      const snap = await getDocs(collection(db, "subcategories"));
      const deletedDoc = snap.docs.find(d => {
        const data = d.data() as { name: string; isDefault?: boolean; deleted?: boolean };
        return data.name === name && data.isDefault && data.deleted;
      });
      
      if (deletedDoc) {
        await deleteDoc(doc(db, "subcategories", deletedDoc.id));
        await fetchFirestoreSubcategories();
        setSuccess("Category restored!");
        setTimeout(() => setSuccess(""), 2000);
      }
    } catch {
      setError("Failed to restore category.");
      setTimeout(() => setError(""), 3000);
    }
  }

  async function handleDeleteSubcategory(id: string, name: string, isDefault: boolean) {
    if (isDefault) {
      // Mark default as deleted (hide it, don't remove)
      setDeletingSubcatId(id);
      try {
        await addDoc(collection(db, "subcategories"), {
          name,
          isDefault: true,
          deleted: true,
          created_at: serverTimestamp()
        });
        // Immediately update local state to hide it
        await fetchFirestoreSubcategories();
        setConfirmDelete(null);
        setSuccess("Category hidden!");
        setTimeout(() => setSuccess(""), 2000);
      } catch {
        setError("Failed to hide category.");
        setTimeout(() => setError(""), 3000);
      } finally {
        setDeletingSubcatId(null);
      }
      return;
    }
    
    // Actually delete custom categories
    setDeletingSubcatId(id);
    try {
      await deleteDoc(doc(db, "subcategories", id));
      // Immediately update local state
      await fetchFirestoreSubcategories();
      setConfirmDelete(null);
      setSuccess("Category removed!");
      setTimeout(() => setSuccess(""), 2000);
    } catch { 
      setError("Failed to remove category.");
      setTimeout(() => setError(""), 3000);
    }
    finally { setDeletingSubcatId(null); }
  }


  function addCustomCategory(value: string, mode: "new" | "edit") {
    const nextCategory = value.trim();
    if (!nextCategory) return;

    if (mode === "new") {
      setCategory(nextCategory);
      setNewCategoryInput("");
      return;
    }

    setEditCategory(nextCategory);
    setEditCategoryInput("");
  }

  function startEdit(item: JewelleryItem) {
    setEditingId(item.id);
    setEditCaption(item.caption);
    setEditCategory(item.category);
    setEditMaterial(item.material || "Gold");
    setEditIsTop6(item.is_top_6);
    setEditCategoryInput("");
  }

  async function handleSaveEdit() {
    if (!editingId) return;
    if (editIsTop6 && !canMarkAsTop6(editingId)) {
      showTop6Popup();
      return;
    }
    try {
      await updateDoc(doc(db, "collections", editingId), {
        caption: editCaption.trim(),
        category: editCategory,
        material: editMaterial,
        is_top_6: editIsTop6,
      });
      setItems(items.map(i => i.id === editingId ? { ...i, caption: editCaption.trim(), category: editCategory, material: editMaterial, is_top_6: editIsTop6 } : i));
      setEditingId(null);
    } catch {
      alert("Failed to update item.");
    }
  }

  async function fetchItems() {
    setLoading(true);
    try {
      const q = query(collection(db, "collections"), orderBy("created_at", "desc"));
      const snap = await getDocs(q);
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<JewelleryItem, "id">) })));
    } catch {
      const snap = await getDocs(collection(db, "collections"));
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<JewelleryItem, "id">) })));
    } finally { setLoading(false); }
  }

  useEffect(() => { fetchItems(); fetchFirestoreSubcategories(); }, []);

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    setFile(f); setPreview(URL.createObjectURL(f));
  }

  function toggleNewTop6() {
    if (!isTop6 && !canMarkAsTop6()) {
      showTop6Popup();
      return;
    }

    setIsTop6(!isTop6);
  }

  function toggleEditTop6(nextValue: boolean) {
    if (nextValue && !canMarkAsTop6(editingId || undefined)) {
      showTop6Popup();
      return;
    }

    setEditIsTop6(nextValue);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setError("Please select an image.");
    if (!caption.trim()) return setError("Caption is required.");
    if (isTop6 && !canMarkAsTop6()) {
      showTop6Popup();
      return;
    }
    setError(""); setSuccess(""); setUploading(true);
    try {
      const optimizedFile = await compressImage(file);
      const storageRef = ref(storage, `collections/${Date.now()}_${optimizedFile.name}`);
      const uploadTask = uploadBytesResumable(storageRef, optimizedFile, {
        contentType: optimizedFile.type,
      });
      const downloadURL = await new Promise<string>((resolve, reject) => {
        uploadTask.on("state_changed",
          (s) => setProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)),
          reject,
          async () => resolve(await getDownloadURL(uploadTask.snapshot.ref))
        );
      });
      await addDoc(collection(db, "collections"), {
        caption: caption.trim(), category, material, image_url: downloadURL,
        is_top_6: isTop6, created_at: serverTimestamp(),
      });
      setSuccess("Item added successfully!");
      setCaption(""); setCategory("Diamond"); setMaterial("Gold"); setIsTop6(false);
      setNewCategoryInput("");
      setFile(null); setPreview(null); setProgress(0);
      if (fileRef.current) fileRef.current.value = "";
      fetchItems();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Upload error:", err);
      console.error("Storage bucket:", process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET);
      setError(`Upload failed: ${msg}`);
    }
    finally { setUploading(false); }
  }

  function requestDelete(item: JewelleryItem) {
    setItemToDelete(item);
  }

  async function handleDelete(item: JewelleryItem) {
    setDeleting(true);
    setError("");
    setSuccess("");
    try {
      try { await deleteObject(ref(storage, item.image_url)); } catch { /* ignore */ }
      await deleteDoc(doc(db, "collections", item.id));
      setItems((p) => p.filter((i) => i.id !== item.id));
      setItemToDelete(null);
      setSuccess("Item deleted successfully!");
    } catch {
      setError("Failed to delete item.");
    } finally {
      setDeleting(false);
    }
  }

  const filteredItems = items.filter((item) => {
    const normalizedMaterial =
      item.material || (MATERIAL_OPTIONS.includes(item.category) ? item.category : "Gold");
    const matchesSearch = item.caption.toLowerCase().includes(searchQuery.trim().toLowerCase());
    const matchesMaterial = materialFilter === "All" || normalizedMaterial === materialFilter;
    const matchesCategory = categoryFilter === "All" || item.category === categoryFilter;

    return matchesSearch && matchesMaterial && matchesCategory;
  });

  const visibleItems = [...filteredItems].sort((a, b) => {
    const createdAtDiff = getCreatedAtValue(b) - getCreatedAtValue(a);
    if (createdAtDiff !== 0) {
      return sortOrder === "newest" ? createdAtDiff : -createdAtDiff;
    }

    return sortOrder === "newest"
      ? b.caption.localeCompare(a.caption)
      : a.caption.localeCompare(b.caption);
  });

  return (
    <div className="max-w-6xl py-6 pb-28 md:pb-6">
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">
              {confirmDelete.id.startsWith('default-') ? 'Hide category?' : 'Remove category?'}
            </h3>
            <p className="mt-2 text-sm text-gray-500">
              {confirmDelete.id.startsWith('default-') ? (
                <>
                  Are you sure you want to hide &quot;{confirmDelete.name}&quot;? This is a default category and will be hidden from the list. You can restore it later if needed.
                </>
              ) : (
                <>
                  Are you sure you want to remove &quot;{confirmDelete.name}&quot;? This will permanently delete this custom category. Existing items won&apos;t be affected.
                </>
              )}
            </p>
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`rounded-xl px-4 py-2 text-sm font-semibold text-white transition-opacity ${
                  confirmDelete.id.startsWith('default-') 
                    ? 'bg-orange-600 hover:bg-orange-700' 
                    : 'bg-red-600 hover:bg-red-700'
                }`}
                onClick={() => {
                  const isDefault = confirmDelete.id.startsWith('default-');
                  handleDeleteSubcategory(confirmDelete.id, confirmDelete.name, isDefault);
                }}
              >
                {confirmDelete.id.startsWith('default-') ? 'Hide' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}

      {top6PopupOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Top 6 is full</h3>
            <p className="mt-2 text-sm text-gray-500">
              You already have 6 featured catalog items. Remove one from Top 6 before adding another.
            </p>
            <div className="mt-5 flex items-center justify-end">
              <button
                type="button"
                className="rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white transition-opacity"
                onClick={() => setTop6PopupOpen(false)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {itemToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Delete item?</h3>
            <p className="mt-2 text-sm text-gray-500">
              This will permanently remove "{itemToDelete.caption}" from the collection.
            </p>
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                onClick={() => setItemToDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                onClick={() => handleDelete(itemToDelete)}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Collections</h1>
        <p className="text-gray-500 mt-1 text-sm">Upload jewellery photos and manage the homepage showcase.</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upload Form */}
        <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-6 shadow-sm">
          <h2 className="text-gray-900 font-semibold mb-5">Add New Item</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Jewellery Photo</label>
              <div onClick={() => fileRef.current?.click()}
                className="relative border-2 border-dashed border-gray-300 rounded-xl overflow-hidden cursor-pointer hover:border-black transition-colors group bg-gray-50">
                {preview
                  ? <div className="relative h-40 w-full">
                      <Image src={preview} alt="Preview" fill unoptimized className="object-cover" />
                    </div>
                  : <div className="flex flex-col items-center justify-center h-40 text-gray-400 group-hover:text-black transition-colors">
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <span className="text-sm">Click to upload image</span>
                      <span className="text-xs mt-1 text-gray-500">JPG, PNG, WEBP</span>
                </div>}
              </div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Caption</label>
              <input type="text" value={caption} onChange={(e) => setCaption(e.target.value)}
                placeholder="e.g. Heritage Polki Choker"
                className="w-full px-4 py-2.5 rounded-xl bg-white border border-gray-300 text-gray-900 placeholder-gray-400 focus:outline-none focus:border-black focus:ring-1 focus:ring-black transition text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Main Category (Material)</label>
              <div className="flex flex-wrap gap-2">
                {MATERIAL_OPTIONS.map((mat) => (
                  <button key={mat} type="button" onClick={() => setMaterial(mat)}
                    className={`px-3 py-1.5 rounded-xl text-sm font-medium border transition-all ${
                      material === mat
                        ? "bg-gray-100 border-gray-300 text-black"
                        : "bg-white border-gray-200 text-gray-500 hover:text-gray-700"}`}>
                    {mat}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-gray-700">Sub Category</label>
                <button
                  type="button"
                  onClick={() => { setManagingCategories(!managingCategories); setNewCategoryInput(""); }}
                  className="flex items-center justify-center w-7 h-7 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-black transition-all"
                  title={managingCategories ? "Done editing" : "Edit categories"}
                >
                  {managingCategories ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
                    </svg>
                  )}
                </button>
              </div>

              {/* Select mode – pick a subcategory */}
              {!managingCategories && (
                <div className="flex flex-wrap gap-2">
                  {categoryOptions.map((cat) => (
                    <button key={cat} type="button" onClick={() => setCategory(cat)}
                      className={`px-3 py-1.5 rounded-xl text-sm font-medium border transition-all ${
                        category === cat
                          ? "bg-black text-white border-black"
                          : "bg-white border-gray-200 text-gray-600 hover:border-gray-400 hover:text-black"}`}>
                      {cat}
                    </button>
                  ))}
                </div>
              )}

              {/* Manage mode – add / delete subcategories */}
              {managingCategories && (
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-3">
                  {/* Add new */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newCategoryInput}
                      onChange={(e) => setNewCategoryInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddSubcategory(newCategoryInput); } }}
                      placeholder="New subcategory name…"
                      className="flex-1 min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-black focus:ring-1 focus:ring-black transition"
                    />
                    <button
                      type="button"
                      disabled={addingSubcat || !newCategoryInput.trim()}
                      onClick={() => handleAddSubcategory(newCategoryInput)}
                      className="shrink-0 rounded-lg bg-black px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-80 disabled:opacity-40"
                    >
                      {addingSubcat
                        ? <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        : "Add"}
                    </button>
                  </div>

                  {/* Active categories */}
                  <div className="flex flex-wrap gap-2">
                    {/* Built-in defaults (not hidden) */}
                    {DEFAULT_SUBCATEGORY_OPTIONS
                      .filter(defCat => {
                        // Check if this default is marked as deleted in Firestore
                        const isHidden = subcategoryDocs.some(doc => 
                          doc.name.toLowerCase() === defCat.toLowerCase() && 
                          doc.isDefault && 
                          (doc as any).deleted
                        );
                        return !isHidden;
                      })
                      .map((cat) => (
                      <span key={`default-${cat}`} className="inline-flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full text-xs font-medium bg-gray-100 border border-gray-200 text-gray-700">
                        {cat}
                        <button
                          type="button"
                          onClick={() => setConfirmDelete({ id: `default-${cat}`, name: cat })}
                          className="flex items-center justify-center w-4 h-4 rounded-full text-gray-400 hover:text-orange-500 hover:bg-orange-100 transition-all ml-0.5"
                          title={`Hide "${cat}"`}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                            <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                          </svg>
                        </button>
                      </span>
                    ))}
                    {/* Custom categories */}
                    {subcategoryDocs
                      .filter(doc => 
                        !doc.isDefault && 
                        !(doc as any).deleted
                      )
                      .map((doc) => (
                      <span key={doc.id} className="inline-flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full text-xs font-medium bg-indigo-50 border border-indigo-200 text-indigo-700">
                        {doc.name}
                        <button
                          type="button"
                          onClick={() => setConfirmDelete({ id: doc.id, name: doc.name })}
                          disabled={deletingSubcatId === doc.id}
                          className="flex items-center justify-center w-4 h-4 rounded-full text-indigo-400 hover:text-red-500 hover:bg-red-100 transition-all disabled:opacity-40 ml-0.5"
                          title={`Remove "${doc.name}"`}
                        >
                          {deletingSubcatId === doc.id
                            ? <span className="inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
                            : <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                                <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                              </svg>
                          }
                        </button>
                      </span>
                    ))}
                  </div>

                  {/* Hidden defaults - show restore option */}
                  {subcategoryDocs.some(doc => doc.isDefault && (doc as any).deleted) && (
                    <div className="pt-2 border-t border-gray-200">
                      <p className="text-xs font-medium text-gray-500 mb-2">Hidden defaults (click to restore):</p>
                      <div className="flex flex-wrap gap-2">
                        {subcategoryDocs
                          .filter(doc => doc.isDefault && (doc as any).deleted)
                          .map((doc) => (
                            <button
                              key={doc.id}
                              type="button"
                              onClick={() => handleRestoreDefault(doc.name)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-gray-50 border border-dashed border-gray-300 text-gray-500 hover:bg-gray-100 hover:text-gray-700 hover:border-gray-400 transition-all"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                                <path fillRule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.371a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.273z" clipRule="evenodd" />
                              </svg>
                              {doc.name}
                            </button>
                          ))}
                      </div>
                    </div>
                  )}

                  <p className="text-[11px] text-gray-400">
                    Grey = defaults (hide with ×), Purple = custom (delete with ×). Hidden defaults can be restored.
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Feature on Homepage</p>
                <p className="text-xs text-gray-500">Show in the Top 6 showcase ({top6Count}/6 used)</p>
              </div>
              <button type="button" onClick={toggleNewTop6}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isTop6 ? "bg-black" : "bg-gray-300"}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${isTop6 ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
            {uploading && (
              <div>
                <div className="flex justify-between text-xs text-gray-500 mb-1"><span>Uploading…</span><span>{progress}%</span></div>
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-black rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}
            {error && <p className="text-black text-sm bg-gray-100 border border-gray-300 rounded-xl px-4 py-2.5">{error}</p>}
            {success && <p className="text-black text-sm bg-gray-100 border border-gray-300 rounded-xl px-4 py-2.5">✓ {success}</p>}
            <button type="submit" disabled={uploading}
              className="w-full py-2.5 bg-black text-white font-semibold rounded-xl transition-all duration-200 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">
              {uploading ? "Uploading…" : "Add to Collection"}
            </button>
          </form>
        </div>

        {/* Items List */}
        <div>
          <div className="mb-4 flex flex-col gap-3">
            <h2 className="text-gray-900 font-semibold">All Items <span className="text-gray-400 font-normal text-sm">({visibleItems.length}/{items.length})</span></h2>
            <div className="rounded-3xl border border-gray-200 bg-white p-3.5 shadow-sm sm:p-4">
              <div className="space-y-3">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by catalog name"
                  className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-black focus:ring-1 focus:ring-black transition"
                />

                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-400">Sort</p>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { label: "New to Old", value: "newest" },
                      { label: "Old to New", value: "oldest" },
                    ] as const).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setSortOrder(option.value)}
                        className={`rounded-2xl px-4 py-3 text-sm font-medium transition-all ${
                          sortOrder === option.value
                            ? "bg-black text-white shadow-sm"
                            : "border border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 hover:text-black"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-400">Material</p>
                  <div className="hide-scrollbar flex gap-2 overflow-x-auto pb-1">
                    {["All", ...MATERIAL_OPTIONS].map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setMaterialFilter(option)}
                        className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-all ${
                          materialFilter === option
                            ? "bg-black text-white shadow-sm"
                            : "border border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 hover:text-black"
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-gray-400">Sub Categories</p>
                    {categoryFilter !== "All" && (
                      <button
                        type="button"
                        onClick={() => setCategoryFilter("All")}
                        className="text-xs font-medium text-gray-500 transition-colors hover:text-black"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="hide-scrollbar flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
                    {["All", ...categoryOptions].map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setCategoryFilter(option)}
                        className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-all ${
                          categoryFilter === option
                            ? "bg-black text-white shadow-sm"
                            : "border border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 hover:text-black"
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
          {loading
            ? <div className="flex items-center gap-3 text-gray-500"><div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />Loading…</div>
            : visibleItems.length === 0
              ? <div className="bg-white border border-gray-200 rounded-2xl p-6 sm:p-8 text-center text-gray-500 shadow-sm">{items.length === 0 ? "No items yet. Add your first piece!" : "No matching items found."}</div>
              : <div className="space-y-3 max-h-[640px] overflow-y-auto pr-1">
                  {visibleItems.map((item) => (
                    <div key={item.id} className="flex items-center gap-4 bg-white border border-gray-200 rounded-xl p-3 hover:border-gray-300 transition-colors shadow-sm group">
                      <div className="relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-gray-50">
                        <Image
                          src={item.image_url}
                          alt={item.caption}
                          fill
                          sizes="56px"
                          className="object-cover"
                        />
                      </div>
                      {editingId === item.id ? (
                        <div className="flex-1 min-w-0 space-y-2">
                          <input type="text" value={editCaption} onChange={(e) => setEditCaption(e.target.value)} className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-black text-gray-900 bg-white" />
                          <div className="flex flex-wrap items-center gap-3">
                            <select value={editMaterial} onChange={(e) => setEditMaterial(e.target.value)} className="px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-black text-gray-900 bg-white">
                              {MATERIAL_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)} className="px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-black text-gray-900 bg-white">
                              {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                              <input type="checkbox" checked={editIsTop6} onChange={(e) => toggleEditTop6(e.target.checked)} className="rounded text-black focus:ring-black" /> Top 6
                            </label>
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <input
                              type="text"
                              value={editCategoryInput}
                              onChange={(e) => setEditCategoryInput(e.target.value)}
                              placeholder="Create sub category"
                              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-black"
                            />
                            <button
                              type="button"
                              onClick={() => addCustomCategory(editCategoryInput, "edit")}
                              className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-black transition-colors hover:bg-gray-50"
                            >
                              Add Tag
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex-1 min-w-0">
                          <p className="text-gray-900 text-sm font-medium truncate">{item.caption}</p>
                          <div className="flex flex-wrap items-center gap-2 mt-1">
                            {(() => {
                              const mat = item.material || (MATERIAL_OPTIONS.includes(item.category) ? item.category : "Gold");
                              return (
                                <>
                                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800 border border-amber-200">{mat}</span>
                                  {item.category && item.category !== mat && (
                                    <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-800 border border-slate-200">{item.category}</span>
                                  )}
                                </>
                              );
                            })()}
                            {item.is_top_6 && <span className="text-xs px-2 py-0.5 rounded-full bg-black text-white font-medium">Top 6</span>}
                          </div>
                        </div>
                      )}
                      <div className="flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity flex-shrink-0">
                        {editingId === item.id ? (
                          <>
                            <button onClick={handleSaveEdit} className="p-2 text-green-600 hover:bg-green-50 rounded-lg" title="Save">✓</button>
                            <button onClick={() => setEditingId(null)} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg" title="Cancel">✕</button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => startEdit(item)} className="p-2 rounded-lg text-gray-400 hover:text-black hover:bg-gray-100 transition-all">
                              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                            </button>
                            <button type="button" onClick={() => requestDelete(item)} className="p-2 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 transition-all">
                              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>}
        </div>
      </div>
    </div>
  );
}
