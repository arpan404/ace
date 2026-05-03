import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Camera, CameraOff, ImageIcon, Trash2, X } from "lucide-react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ace/contracts";
import { Radius, withAlpha } from "../design/system";
import { useTheme } from "../design/ThemeContext";
import {
  buildMobileImageAttachmentsFromAssets,
  attachmentPermissionCopy,
  estimateBase64Bytes,
  formatBytes,
  toUploadChatAttachments,
  type AttachmentPermissionKind,
  type AttachmentPermissionStatus,
  type MobileImageAttachment,
} from "./imageAttachmentData";

export {
  queuedComposerImageToMobileImageAttachment,
  toUploadChatAttachments,
  type MobileImageAttachment,
} from "./imageAttachmentData";

interface ImageAttachmentCaptureProps {
  readonly images: ReadonlyArray<MobileImageAttachment>;
  readonly onImagesChange: (images: MobileImageAttachment[]) => void;
  readonly disabled?: boolean;
  readonly compact?: boolean;
}

function makeMobileImageId(): string {
  return `mobile_image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function showAttachmentPermissionAlert(
  kind: AttachmentPermissionKind,
  permission: AttachmentPermissionStatus,
) {
  const copy = attachmentPermissionCopy(kind, permission);
  if (!copy.settingsLabel) {
    Alert.alert(copy.title, copy.message);
    return;
  }

  Alert.alert(copy.title, copy.message, [
    { text: "Cancel", style: "cancel" },
    {
      text: copy.settingsLabel,
      onPress: () => {
        void Linking.openSettings();
      },
    },
  ]);
}

export function ImageAttachmentCapture({
  images,
  onImagesChange,
  disabled = false,
  compact = false,
}: ImageAttachmentCaptureProps) {
  const { colors } = useTheme();
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [mediaLibraryPermission, requestMediaLibraryPermission] =
    ImagePicker.useMediaLibraryPermissions();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const openCamera = useCallback(async () => {
    if (disabled) {
      return;
    }
    if (images.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      Alert.alert(
        "Attachment limit reached",
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images to a turn.`,
      );
      return;
    }

    const nextPermission = permission?.granted ? permission : await requestPermission();
    if (!nextPermission.granted) {
      showAttachmentPermissionAlert("camera", nextPermission);
      return;
    }

    setCameraReady(false);
    setCameraOpen(true);
  }, [disabled, images.length, permission, requestPermission]);

  const addPickedAssets = useCallback(
    (assets: ReadonlyArray<ImagePicker.ImagePickerAsset>) => {
      const result = buildMobileImageAttachmentsFromAssets({
        assets,
        existingCount: images.length,
        makeId: makeMobileImageId,
        now: new Date(),
      });

      if (result.rejectedForSize > 0) {
        Alert.alert(
          "Some images were too large",
          `Each image must be ${formatBytes(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)} or smaller.`,
        );
      }

      if (result.attachments.length > 0) {
        onImagesChange([...images, ...result.attachments]);
      }
    },
    [images, onImagesChange],
  );

  const openLibrary = useCallback(async () => {
    if (disabled) {
      return;
    }
    const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - images.length;
    if (remainingSlots <= 0) {
      Alert.alert(
        "Attachment limit reached",
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images to a turn.`,
      );
      return;
    }

    const nextPermission = mediaLibraryPermission?.granted
      ? mediaLibraryPermission
      : await requestMediaLibraryPermission();
    if (!nextPermission.granted) {
      showAttachmentPermissionAlert("photo-library", nextPermission);
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
      base64: true,
      quality: 0.82,
    });

    if (!result.canceled) {
      addPickedAssets(result.assets);
    }
  }, [
    addPickedAssets,
    disabled,
    images.length,
    mediaLibraryPermission,
    requestMediaLibraryPermission,
  ]);

  const captureImage = useCallback(async () => {
    if (!cameraReady || capturing || images.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      return;
    }

    setCapturing(true);
    try {
      const picture = await cameraRef.current?.takePictureAsync({
        base64: true,
        quality: 0.72,
        exif: false,
      });
      if (!picture?.base64) {
        Alert.alert("Capture failed", "The camera did not return image data.");
        return;
      }

      const sizeBytes = estimateBase64Bytes(picture.base64);
      if (sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        Alert.alert(
          "Image too large",
          `Captured image is ${formatBytes(sizeBytes)}. The limit is ${formatBytes(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)}.`,
        );
        return;
      }

      const dataUrl = `data:image/jpeg;base64,${picture.base64}`;
      const capturedAt = new Date();
      onImagesChange([
        ...images,
        {
          id: makeMobileImageId(),
          type: "image",
          name: `mobile-photo-${capturedAt.toISOString().replace(/[:.]/g, "-")}.jpg`,
          mimeType: "image/jpeg",
          sizeBytes,
          dataUrl,
          previewUri: picture.uri || dataUrl,
        },
      ]);
      setCameraOpen(false);
    } catch (error) {
      Alert.alert(
        "Capture failed",
        error instanceof Error ? error.message : "Could not attach the photo.",
      );
    } finally {
      setCapturing(false);
    }
  }, [cameraReady, capturing, images, onImagesChange]);

  const recoverCameraPermission = useCallback(async () => {
    if (permission?.canAskAgain === false) {
      await Linking.openSettings();
      return;
    }

    const nextPermission = await requestPermission();
    if (!nextPermission.granted) {
      showAttachmentPermissionAlert("camera", nextPermission);
      return;
    }
    setCameraReady(false);
  }, [permission?.canAskAgain, requestPermission]);

  return (
    <View style={compact ? styles.compactRoot : styles.root}>
      <View style={styles.actionRow}>
        <View style={styles.attachActions}>
          <Pressable
            onPress={() => void openCamera()}
            disabled={disabled}
            style={[
              styles.attachButton,
              {
                backgroundColor: colors.surfaceSecondary,
                borderColor: colors.elevatedBorder,
              },
              disabled && styles.disabled,
            ]}
          >
            <Camera size={16} color={colors.primary} strokeWidth={2.2} />
            <Text style={[styles.attachLabel, { color: colors.foreground }]}>Camera</Text>
          </Pressable>
          <Pressable
            onPress={() => void openLibrary()}
            disabled={disabled}
            style={[
              styles.attachButton,
              {
                backgroundColor: colors.surfaceSecondary,
                borderColor: colors.elevatedBorder,
              },
              disabled && styles.disabled,
            ]}
          >
            <ImageIcon size={16} color={colors.primary} strokeWidth={2.2} />
            <Text style={[styles.attachLabel, { color: colors.foreground }]}>Library</Text>
          </Pressable>
        </View>
        <Text style={[styles.countLabel, { color: colors.tertiaryLabel }]}>
          {images.length}/{PROVIDER_SEND_TURN_MAX_ATTACHMENTS}
        </Text>
      </View>

      {images.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.imageStrip}
        >
          {images.map((image) => (
            <View
              key={image.id}
              style={[
                styles.thumbnailFrame,
                {
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
              ]}
            >
              <Image source={{ uri: image.previewUri }} style={styles.thumbnail} />
              <Pressable
                onPress={() =>
                  onImagesChange(images.filter((candidate) => candidate.id !== image.id))
                }
                style={[
                  styles.removeButton,
                  { backgroundColor: withAlpha(colors.background, 0.92) },
                ]}
              >
                <Trash2 size={13} color={colors.red} strokeWidth={2.2} />
              </Pressable>
              <Text
                style={[styles.thumbnailMeta, { color: colors.secondaryLabel }]}
                numberOfLines={1}
              >
                {formatBytes(image.sizeBytes)}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <Modal visible={cameraOpen} animationType="slide" presentationStyle="fullScreen">
        <View style={[styles.cameraScreen, { backgroundColor: colors.background }]}>
          <View style={[styles.cameraHeader, { borderBottomColor: colors.separator }]}>
            <View>
              <Text style={[styles.cameraTitle, { color: colors.foreground }]}>Attach photo</Text>
              <Text style={[styles.cameraSubtitle, { color: colors.secondaryLabel }]}>
                Capture context for this agent turn
              </Text>
            </View>
            <Pressable
              onPress={() => setCameraOpen(false)}
              style={[styles.closeButton, { backgroundColor: colors.surfaceSecondary }]}
            >
              <X size={18} color={colors.foreground} strokeWidth={2.2} />
            </Pressable>
          </View>

          {permission?.granted ? (
            <View style={styles.cameraFrame}>
              <CameraView
                ref={cameraRef}
                style={styles.camera}
                facing="back"
                onCameraReady={() => setCameraReady(true)}
              />
            </View>
          ) : (
            <View style={styles.permissionFallback}>
              <CameraOff size={32} color={colors.muted} strokeWidth={1.8} />
              <Text style={[styles.permissionText, { color: colors.secondaryLabel }]}>
                Camera permission is required before taking an attachment photo.
              </Text>
              <Pressable
                onPress={() => void recoverCameraPermission()}
                style={[
                  styles.permissionRecoveryButton,
                  {
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                ]}
              >
                <Text style={[styles.permissionRecoveryText, { color: colors.foreground }]}>
                  {permission?.canAskAgain === false ? "Open Settings" : "Allow Camera"}
                </Text>
              </Pressable>
            </View>
          )}

          <View style={[styles.cameraFooter, { borderTopColor: colors.separator }]}>
            <Pressable
              onPress={() => void captureImage()}
              disabled={!cameraReady || capturing}
              style={[
                styles.captureButton,
                { backgroundColor: cameraReady ? colors.primary : colors.surfaceSecondary },
                (!cameraReady || capturing) && styles.disabled,
              ]}
            >
              {capturing ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text
                  style={[
                    styles.captureButtonText,
                    { color: cameraReady ? colors.primaryForeground : colors.muted },
                  ]}
                >
                  Capture
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginTop: 12,
    gap: 10,
  },
  compactRoot: {
    gap: 8,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  attachActions: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  attachButton: {
    minHeight: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  attachLabel: {
    fontSize: 13,
    fontWeight: "800",
  },
  countLabel: {
    fontSize: 12,
    fontWeight: "800",
  },
  imageStrip: {
    gap: 10,
    paddingBottom: 2,
  },
  thumbnailFrame: {
    width: 86,
    borderRadius: 18,
    borderWidth: 1,
    padding: 5,
  },
  thumbnail: {
    width: 74,
    height: 74,
    borderRadius: 14,
  },
  removeButton: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbnailMeta: {
    marginTop: 5,
    fontSize: 10,
    fontWeight: "800",
    textAlign: "center",
  },
  cameraScreen: {
    flex: 1,
  },
  cameraHeader: {
    paddingHorizontal: 20,
    paddingTop: 62,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  cameraTitle: {
    fontSize: 22,
    lineHeight: 27,
    fontWeight: "900",
    letterSpacing: -0.3,
  },
  cameraSubtitle: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  closeButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraFrame: {
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  permissionFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 14,
  },
  permissionText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    fontWeight: "600",
  },
  permissionRecoveryButton: {
    minHeight: 48,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  permissionRecoveryText: {
    fontSize: 14,
    fontWeight: "900",
  },
  cameraFooter: {
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 34,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  captureButton: {
    minHeight: 56,
    borderRadius: Radius.card,
    alignItems: "center",
    justifyContent: "center",
  },
  captureButtonText: {
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: -0.2,
  },
  disabled: {
    opacity: 0.56,
  },
});
