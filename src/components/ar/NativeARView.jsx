import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { createARView } from "capacitor-arcore";
import { IoClose, IoInformationCircle, IoCamera } from "react-icons/io5";
import { MdOutlineViewInAr } from "react-icons/md";
import { HiOutlineCube } from "react-icons/hi2";

import {
  FilterModal,
  CustomizeSheet,
  ScreenshotPreview,
  ProductCatalog,
  ScanningOverlay,
  PlacingIndicator,
  ActionMenu,
  InfoModal,
  TutorialOverlay,
  PRICE_RANGES,
  SORT_OPTIONS,
} from "./components";

import { getProductImageUrl, getModelUrl as getModelUrlUtil } from "../../utils/imageUrl";

const getProductImage = (product) => getProductImageUrl(product);

const getModelUrl = (product) => getModelUrlUtil(product);


// arcore-react currently flips the WebXR camera texture once in its capture
// shader and once again while composing GL readbacks. Patch only the camera
// readback on this ARView instance so screenshots match the live camera view.
const fixScreenshotCameraOrientation = (view) => {
  const engine = view?.engine;
  if (!engine || engine.__auraScreenshotOrientationFixed) return;

  engine._readCameraTexture = function readCameraTexture(gl, cameraTexture, width, height) {
    const vs = `attribute vec2 p; varying vec2 uv; void main(){uv=(p+1.0)*.5; gl_Position=vec4(p,0.,1.);}`;
    // Do not flip Y here. _composeScreenshot() already converts the GL
    // bottom-left origin to the canvas top-left origin for both layers.
    const fs = `precision mediump float; varying vec2 uv; uniform sampler2D tex; void main(){gl_FragColor=texture2D(tex, uv);}`;
    const shader = (type, source) => {
      const item = gl.createShader(type);
      gl.shaderSource(item, source);
      gl.compileShader(item);
      if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(item) || "Camera shader failed");
      }
      return item;
    };

    const program = gl.createProgram();
    const vertex = shader(gl.VERTEX_SHADER, vs);
    const fragment = shader(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Camera capture program failed");
    }

    const outputTexture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    const buffer = gl.createBuffer();
    const pixels = new Uint8Array(width * height * 4);

    try {
      gl.bindTexture(gl.TEXTURE_2D, outputTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0);
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const location = gl.getAttribLocation(program, "p");
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
      gl.uniform1i(gl.getUniformLocation(program, "tex"), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteBuffer(buffer);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(outputTexture);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      engine.renderer?.resetState?.();
    }
  };

  engine.__auraScreenshotOrientationFixed = true;
};

const NativeARView = ({
  products = [],
  categories = [],
  selectedProduct,
  onProductSelect,
  customization,
  onCustomize,
  onClose,
  onAddToCart,
  isLoading = false,
}) => {
  const overlayRef = useRef(null);

  const arViewRef = useRef(null);
  const gestureCleanupRef = useRef(null);
  const selectedProductRef = useRef(selectedProduct);
  const frameCleanupRef = useRef(null);
  const [isSupported, setIsSupported] = useState(null);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [arError, setArError] = useState(null);

  const [currentAnchor, setCurrentAnchor] = useState(null);
  const [showCustomize, setShowCustomize] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [isPlacing, setIsPlacing] = useState(false);
  const [hasPlacedModel, setHasPlacedModel] = useState(false);
  const [surfaceDetected, setSurfaceDetected] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [filterCategory, setFilterCategory] = useState("All");
  const [filterPriceRange, setFilterPriceRange] = useState(PRICE_RANGES[0]);
  const [filterSort, setFilterSort] = useState(SORT_OPTIONS[0]);
  const [screenshotData, setScreenshotData] = useState(null);
  const [showScreenshotPreview, setShowScreenshotPreview] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [screenshotError, setScreenshotError] = useState(null);
  const [tutorialStep, setTutorialStep] = useState(0);

  const categoryNames = useMemo(() => {
    return ["All", ...categories.map((c) => c.name)];
  }, [categories]);

  useEffect(() => {
    selectedProductRef.current = selectedProduct;
  }, [selectedProduct]);

  const filteredProducts = useMemo(() => {
    let result = [...products];

    if (filterCategory !== "All") {
      result = result.filter((p) => {
        const catName = typeof p.category === "object" ? p.category?.name : "";
        return catName.toLowerCase().includes(filterCategory.toLowerCase());
      });
    }

    result = result.filter(
      (p) =>
        (p.price || 0) >= filterPriceRange.min &&
        (p.price || 0) <= filterPriceRange.max
    );

    if (filterSort.value === "price_asc")
      result.sort((a, b) => (a.price || 0) - (b.price || 0));
    else if (filterSort.value === "price_desc")
      result.sort((a, b) => (b.price || 0) - (a.price || 0));
    else if (filterSort.value === "name_asc")
      result.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    return result;
  }, [products, filterCategory, filterPriceRange, filterSort]);

  const triggerHaptic = useCallback((type = "light") => {
    if ("vibrate" in navigator) {
      const patterns = {
        light: [10],
        medium: [20],
        heavy: [30],
        success: [10, 50, 10],
        error: [50, 30, 50],
      };
      navigator.vibrate(patterns[type] || patterns.light);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const view = createARView({ overlay: overlayRef.current });
    fixScreenshotCameraOrientation(view);
    arViewRef.current = view;
    view.checkSupport()
      .then(({ supported, reason }) => {
        if (!cancelled) {
          setIsSupported(supported);
          if (!supported && reason) setArError(reason);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setIsSupported(false);
          setArError(err.message);
        }
      });
    return () => {
      cancelled = true;
      gestureCleanupRef.current?.();
      frameCleanupRef.current?.();
      view.destroy().catch(() => {});
      if (arViewRef.current === view) arViewRef.current = null;
    };
  }, []);

  const handleStartAR = useCallback(async () => {
    const view = arViewRef.current;
    if (!isSupported || !overlayRef.current || !view) return;
    triggerHaptic("medium");
    try {
      view.overlay = overlayRef.current;
      await view.create({
        overlay: overlayRef.current,
        planeDetection: true,
        lightEstimation: true,
        showReticle: true,
        showPlaneDots: true,
        showShadow: true,
      });
      frameCleanupRef.current?.();
      frameCleanupRef.current = view.onFrame((event) => {
        if (event?.type === "surfaceDetected") setSurfaceDetected(true);
        if (event?.type === "surfaceLost" || event?.type === "sessionEnded") {
          setSurfaceDetected(false);
        }
      });

      const modelUrls = [...new Set(products.map(getModelUrl).filter(Boolean))];
      await view.preloadModels(modelUrls);

      gestureCleanupRef.current?.();
      gestureCleanupRef.current = view.enableCustomization({
        modelUrl: () => getModelUrl(selectedProductRef.current),
        onTap: () => {
          if (view.activeModelId) {
            setCurrentAnchor(view.activeModelId);
            setHasPlacedModel(true);
            setShowActions((prev) => !prev);
          }
        },
        onScale: () => { if (tutorialStep === 0) setTutorialStep(1); },
        onRotate: () => { if (tutorialStep === 0) setTutorialStep(1); },
      });
      setIsSessionActive(true);
      setArError(null);
    } catch (err) {
      setArError(err.message || "Failed to start AR");
      setIsSessionActive(false);
    }
  }, [isSupported, products, tutorialStep, triggerHaptic]);

  const placeModelAtCenter = useCallback(async () => {
    const view = arViewRef.current;
    if (!view || isPlacing || !isSessionActive || !selectedProduct) return;
    const modelUrl = getModelUrl(selectedProduct);
    if (!modelUrl) return;
    setIsPlacing(true);
    triggerHaptic("medium");
    try {
      const result = await view.placeModel(modelUrl, { x: 0.5, y: 0.5 });
      if (result.success) {
        setCurrentAnchor(result.modelId);
        setHasPlacedModel(true);
        triggerHaptic("success");
      } else {
        triggerHaptic("error");
      }
    } catch (err) {
      setArError(err.message);
      triggerHaptic("error");
    } finally {
      setIsPlacing(false);
    }
  }, [isSessionActive, selectedProduct, isPlacing, triggerHaptic]);

  const handleRemoveModel = useCallback(async () => {
    if (!arViewRef.current?.activeModelId) return;
    triggerHaptic("medium");
    await arViewRef.current.removeModel();
    setCurrentAnchor(null);
    setHasPlacedModel(false);
    setShowActions(false);
    setShowCustomize(false);
  }, [triggerHaptic]);

  const handleChangeProduct = useCallback(
    async (product) => {
      onProductSelect(product);
      triggerHaptic("light");
      const view = arViewRef.current;
      const modelUrl = getModelUrl(product);
      if (!view || !modelUrl || !hasPlacedModel) return;
      setIsPlacing(true);
      try {
        const result = await view.switchModel(modelUrl);
        setCurrentAnchor(result.modelId || view.activeModelId);
        triggerHaptic("success");
      } catch (err) {
        setArError(err.message);
        triggerHaptic("error");
      } finally {
        setIsPlacing(false);
      }
    },
    [hasPlacedModel, onProductSelect, triggerHaptic]
  );

  const setModelColor = useCallback(async (_anchorId, color) => {
    try {
      await arViewRef.current?.setColor(color);
    } catch (err) {
      setArError(err.message);
    }
  }, []);

  const calculateTotalPrice = useCallback(() => {
    if (!selectedProduct) return 0;
    return (
      (selectedProduct.price || 0) +
      (customization?.material?.priceModifier || 0) +
      (customization?.size?.priceModifier || 0)
    );
  }, [selectedProduct, customization]);

  const captureScreenshot = useCallback(async () => {
    const view = arViewRef.current;
    if (!view || !isSessionActive || isCapturing) return;
    setIsCapturing(true);
    setShowActions(false);
    triggerHaptic("medium");
    try {
      const result = await view.takeScreenshot({ format: "jpeg", quality: 0.92, includeReticle: false });
      const dataUrl = result?.dataUrl || result?.data;
      if (result?.success !== false && dataUrl) {
        setScreenshotData(dataUrl);
        setShowScreenshotPreview(true);
        triggerHaptic("success");
      } else {
        throw new Error(result?.error || "Could not capture AR view");
      }
    } catch (err) {
      triggerHaptic("error");
      setScreenshotError(err.message || "Screenshot failed");
      setTimeout(() => setScreenshotError(null), 3000);
    } finally {
      setIsCapturing(false);
    }
  }, [isSessionActive, isCapturing, triggerHaptic]);

  const downloadScreenshot = useCallback(() => {
    if (!screenshotData) return;
    const link = document.createElement("a");
    link.download = `AR-${selectedProduct?.name || "capture"
      }-${Date.now()}.jpg`;
    link.href = screenshotData;
    link.click();
    triggerHaptic("success");
  }, [screenshotData, selectedProduct, triggerHaptic]);

  const shareScreenshot = useCallback(async () => {
    if (!screenshotData) return;
    try {
      const blob = await (await fetch(screenshotData)).blob();
      const file = new File([blob], `AR-${Date.now()}.jpg`, {
        type: "image/jpeg",
      });
      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: `${selectedProduct?.name || "Furniture"} in AR`,
        });
        triggerHaptic("success");
      } else {
        downloadScreenshot();
      }
    } catch (err) {
      downloadScreenshot();
    }
  }, [screenshotData, selectedProduct, downloadScreenshot, triggerHaptic]);

  if (isSupported === null || isLoading) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-8 bg-black">
        <div className="w-full max-w-sm p-8 bg-zinc-900 border border-zinc-800 rounded-3xl text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-zinc-800 relative overflow-hidden shimmer-element mx-auto flex items-center justify-center">
            <MdOutlineViewInAr size={28} className="text-teal-500" />
          </div>
          <div className="w-3/4 h-5 rounded bg-zinc-800 relative overflow-hidden shimmer-element mx-auto" />
          <div className="w-1/2 h-3 rounded bg-zinc-800 relative overflow-hidden shimmer-element mx-auto" />
          <p className="text-gray-400 text-xs mt-2">Initializing AR Environment...</p>
        </div>
      </div>
    );
  }

  if (isSupported === false) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 bg-white text-center p-8">
        <div className="w-24 h-24 border border-gray-200 rounded-full flex items-center justify-center">
          <MdOutlineViewInAr size={40} className="text-gray-400" />
        </div>
        <div>
          <h2
            className="text-2xl text-gray-900"
            style={{ fontFamily: "Georgia, serif" }}
          >
            AR Not Supported
          </h2>
          <p className="text-gray-500 mt-3 max-w-xs leading-relaxed">
            Your device doesn't support augmented reality features
          </p>
        </div>
        <div className="bg-teal-50 border border-teal-100 rounded-2xl p-4 max-w-xs">
          <p className="text-sm text-teal-700">
            Try using <span className="font-medium">Chrome browser</span> on an
            ARCore-supported Android device
          </p>
        </div>
        <button
            data-ui="true"
          onClick={onClose}
          className="mt-2 px-8 py-3 bg-teal-600 hover:bg-teal-700 text-white rounded-full font-medium transition-all duration-200 active:scale-95"
        >
          Go Back
        </button>
      </div>
    );
  }

  if (products.length === 0 && !isLoading) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 bg-white text-center p-8">
        <div className="w-24 h-24 border border-gray-200 rounded-full flex items-center justify-center">
          <MdOutlineViewInAr size={40} className="text-gray-400" />
        </div>
        <div>
          <h2
            className="text-2xl text-gray-900"
            style={{ fontFamily: "Georgia, serif" }}
          >
            No AR Products
          </h2>
          <p className="text-gray-500 mt-3 max-w-xs leading-relaxed">
            No products with AR models are currently available
          </p>
        </div>
        <button
            data-ui="true"
          onClick={onClose}
          className="mt-2 px-8 py-3 bg-teal-600 hover:bg-teal-700 text-white rounded-full font-medium transition-all duration-200 active:scale-95"
        >
          Go Back
        </button>
      </div>
    );
  }

  const hasActiveFilters =
    filterCategory !== "All" ||
    filterPriceRange.min > 0 ||
    filterSort.value !== "default";

  return (
    <div className="fixed inset-0 bg-black overflow-hidden">
      {!isSessionActive && (
        <div className="absolute inset-0 bg-black flex items-center justify-center p-6">
          <div className="bg-zinc-900 rounded-2xl p-6 max-w-sm w-full border border-zinc-800">
            <div className="flex items-center justify-center w-16 h-16 bg-teal-600/20 rounded-full mx-auto mb-4">
              <IoCamera size={32} className="text-teal-500" />
            </div>
            <h3 className="text-white text-lg font-semibold text-center mb-2">
              Camera Access Required
            </h3>
            <p className="text-gray-400 text-sm text-center mb-6">
              This app needs camera access to show furniture in your space using
              augmented reality.
            </p>
            <button
            data-ui="true"
              onClick={handleStartAR}
              className="w-full py-3.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl font-medium transition-all duration-200 active:scale-[0.98]"
            >
              Allow Camera Access
            </button>
            <button
              onClick={onClose}
              className="w-full py-3 text-gray-500 text-sm mt-2"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      <div
        ref={overlayRef}
        className="absolute inset-0 pointer-events-none *:pointer-events-auto"
        style={{ touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
      >
        {isSessionActive && (
          <div
            className="absolute inset-0 z-1"
          >
            <ScanningOverlay
              hasPlacedModel={hasPlacedModel}
              surfaceDetected={surfaceDetected}
              isPlacing={isPlacing}
            />
            <PlacingIndicator isPlacing={isPlacing} />
          </div>
        )}

        <div
          className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 pt-[calc(12px+env(safe-area-inset-top,12px))] z-100"
          data-hide-on-capture
          data-ui="true"
        >
          <button
            onClick={onClose}
            className="w-11 h-11 rounded-full bg-black/40 backdrop-blur-xl text-white flex items-center justify-center active:scale-95 transition-all"
          >
            <IoClose size={22} />
          </button>

          <div className="flex items-center gap-2 px-4 py-2.5 bg-black/40 backdrop-blur-xl rounded-full">
            <div className="w-2 h-2 bg-teal-400 rounded-full animate-pulse" />
            <span className="text-sm font-medium text-white">AR View</span>
          </div>

          <button
            onClick={() => setShowInfo(true)}
            className="w-11 h-11 rounded-full bg-black/40 backdrop-blur-xl text-white flex items-center justify-center active:scale-95 transition-all"
          >
            <IoInformationCircle size={22} />
          </button>
        </div>

        <div data-ui="true">
        <ActionMenu
          show={showActions}
          hasPlacedModel={hasPlacedModel}
          onCustomize={() => {
            setShowCustomize(true);
            setShowActions(false);
          }}
          onCapture={() => {
            setShowActions(false);
            captureScreenshot();
          }}
          onRemove={handleRemoveModel}
        />
        </div>

        <TutorialOverlay
          tutorialStep={tutorialStep}
          hasPlacedModel={hasPlacedModel}
          showActions={showActions}
          showCustomize={showCustomize}
          onSkip={() => setTutorialStep(2)}
        />

        {isSessionActive && !showCustomize && (
          <div data-ui="true">
          <ProductCatalog
            products={filteredProducts}
            selectedProduct={selectedProduct}
            onProductSelect={handleChangeProduct}
            onFilterClick={() => setShowFilter(true)}
            hasActiveFilters={hasActiveFilters}
            getProductImage={getProductImage}
          />
          </div>
        )}

        <div data-ui="true">
        <FilterModal
          show={showFilter}
          onClose={() => setShowFilter(false)}
          categoryNames={categoryNames}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterPriceRange={filterPriceRange}
          setFilterPriceRange={setFilterPriceRange}
          filterSort={filterSort}
          setFilterSort={setFilterSort}
        />

        <CustomizeSheet
          show={showCustomize}
          onClose={() => setShowCustomize(false)}
          selectedProduct={selectedProduct}
          customization={customization}
          onCustomize={onCustomize}
          currentAnchor={currentAnchor}
          setModelColor={setModelColor}
          triggerHaptic={triggerHaptic}
          getProductImage={getProductImage}
          calculateTotalPrice={calculateTotalPrice}
        />

        <InfoModal show={showInfo} onClose={() => setShowInfo(false)} />

        <ScreenshotPreview
          show={showScreenshotPreview}
          screenshotData={screenshotData}
          selectedProduct={selectedProduct}
          onClose={() => setShowScreenshotPreview(false)}
          onDownload={downloadScreenshot}
          onShare={shareScreenshot}
        />
        </div>

        {arError && (
          <div data-ui="true" className="absolute top-20 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-rose-500/90 backdrop-blur-xl text-white px-5 py-3 rounded-full z-300 animate-[toast-in_0.3s_ease]">
            <span className="text-sm font-medium">{arError}</span>
            <button
              onClick={() => setArError(null)}
              className="w-6 h-6 bg-white/20 rounded-full flex items-center justify-center active:scale-90 transition-all hover:bg-white/30"
            >
              <IoClose size={14} />
            </button>
          </div>
        )}

        {screenshotError && (
          <div data-ui="true" className="absolute top-20 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-rose-500/90 backdrop-blur-xl text-white px-5 py-3 rounded-full z-300 animate-[toast-in_0.3s_ease]">
            <IoCamera size={16} />
            <span className="text-sm font-medium">{screenshotError}</span>
            <button
              onClick={() => setScreenshotError(null)}
              className="w-6 h-6 bg-white/20 rounded-full flex items-center justify-center active:scale-90 transition-all"
            >
              <IoClose size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default NativeARView;
