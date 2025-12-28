/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import * as functions from "firebase-functions";
import {Request, Response} from "express";
import {ImageAnnotatorClient} from "@google-cloud/vision";

// Inicializa el cliente de la API de Vision.
// Cloud Functions se autentica automáticamente con las credenciales del servicio predeterminado.
const visionClient = new ImageAnnotatorClient();

// Configuración global de funciones
functions.setGlobalOptions({
  maxInstances: 10,
  region: "southamerica-east1",
});

interface PlateDetection {
  plate: string;
  confidence: number; // 0-1
  format: "mercosur" | "old" | "unknown";
  position?: { // Posición relativa en la imagen
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Cloud Function para detectar texto en una imagen usando Google Cloud Vision API.
 * Espera una imagen Base64 en el cuerpo de la solicitud (data.image).
 */
export const detectLicensePlate = functions.https.onRequest(
  async (req: Request, res: Response) => {
    // Establece cabeceras CORS
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.set("Access-Control-Max-Age", "3600");
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({
        error: "Método no permitido",
        message: "Solo se aceptan solicitudes POST",
      });
      return;
    }

    const imageData = req.body.image;

    if (!imageData || typeof imageData !== "string") {
      res.status(400).json({
        error: "Imagen no proporcionada",
        message: "No se proporcionó la imagen en formato Base64.",
      });
      return;
    }

    try {
      const base64Image = imageData.replace(
        /^data:image\/(png|jpeg|jpg|webp|bmp);base64,/i,
        ""
      );

      if (!base64Image) {
        res.status(400).json({
          error: "Formato de imagen inválido",
          message: "El formato Base64 de la imagen es incorrecto.",
        });
        return;
      }

      const imageBuffer = Buffer.from(base64Image, "base64");

      const [result] = await visionClient.textDetection(imageBuffer);
      const detections = result.textAnnotations;

      if (!detections || detections.length === 0) {
        res.status(200).json({
          plates: [],
          confidence: 0,
          automationLevel: "none",
          message: "No se detectó texto",
        });
        return;
      }

      const fullText = detections[0].description || "";
      const detectedPlates: PlateDetection[] = [];

      // --- Algoritmo mejorado de scoring ---

      // 1. Buscar todas las posibles patentes
      const allPotentialPlates = findAllPotentialPlates(fullText);

      // 2. Calcular score para cada una
      for (const plate of allPotentialPlates) {
        const score = calculatePlateConfidence(plate, fullText, detections);

        if (score > 0.4) { // Umbral mínimo
          detectedPlates.push({
            plate: plate.toUpperCase(),
            confidence: score,
            format: getPlateFormat(plate),
            // Podrías calcular posición si usas textAnnotations[1+]
          });
        }
      }

      // 3. Ordenar por confianza
      detectedPlates.sort((a, b) => b.confidence - a.confidence);

      // 4. Determinar nivel de automatización
      const automationLevel = determineAutomationLevel(detectedPlates);

      res.status(200).json({
        plates: detectedPlates,
        fullTextDetected: fullText,
        confidence: detectedPlates[0]?.confidence || 0,
        automationLevel: automationLevel,
        suggestedAction: getSuggestedAction(automationLevel),
      });
    } catch (error) {
      console.error("Error:", error);
      const errorMessage = error instanceof Error ? error.message : "Error desconocido";
      res.status(500).json({
        error: "Error interno del servidor",
        details: process.env.NODE_ENV === "development" ? errorMessage : undefined,
      });
      return;
    }
  }
);

// --- Funciones auxiliares ---

interface TextAnnotation {
  description?: string | null;
  // Add other properties if they are used elsewhere and need strict typing
  // boundingPoly?: BoundingPoly;
  // locale?: string;
}

/**
 * Determina el formato de una patente (Mercosur, Antiguo o Desconocido).
 * @param {string} plate - La cadena de la patente a analizar.
 * @return {"mercosur" | "old" | "unknown"} El formato de la patente.
 */
function getPlateFormat(plate: string): "mercosur" | "old" | "unknown" {
  if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(plate)) {
    return "mercosur";
  }
  if (/^[A-Z]{3}\d{3}$/.test(plate)) {
    return "old";
  }
  return "unknown";
}

/**
 * Encuentra todas las posibles cadenas que podrían ser patentes en un texto dado.
 * Utiliza varios patrones de expresiones regulares para identificar formatos comunes.
 * @param {string} text - El texto completo donde buscar patentes.
 * @return {string[]} Un array de cadenas que son posibles patentes.
 */
function findAllPotentialPlates(text: string): string[] {
  const patterns = [
    // Mercosur: AA NNN AA
    /[A-Z]{2}\s?\d{3}\s?[A-Z]{2}/gi,
    // Antiguo: AAA NNN
    /[A-Z]{3}\s?\d{3}/gi,
    // Variantes
    /[A-Z]{2}\d{3}[A-Z]{2}/gi,
    /[A-Z]{3}\d{3}/gi,
    // Con posibles errores comunes (0/O, 8/B, 1/I)
    /[A-Z0-9]{2,3}\s?\d{3}(\s?[A-Z0-9]{2})?/gi,
  ];

  const plates = new Set<string>();
  patterns.forEach((pattern) => {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach((match) => {
        // Limpiar y normalizar
        const clean = match.replace(/\s/g, "").toUpperCase();
        if (clean.length >= 5 && clean.length <= 8) {
          plates.add(clean);
        }
      });
    }
  });

  return Array.from(plates);
}

/**
 * Calcula un score de confianza para una patente detectada.
 * El score se basa en el formato de la patente, su posición en el texto completo
 * y la frecuencia de aparición en las detecciones individuales.
 * @param {string} plate - La patente para la cual calcular la confianza.
 * @param {string} fullText - El texto completo detectado por la API de Vision.
 * @param {TextAnnotation[]} detections - Un array de detecciones individuales de texto de la API de Vision.
 * @return {number} El score de confianza (0.0 a 1.0).
 */
function calculatePlateConfidence(plate: string, fullText: string, detections: TextAnnotation[]): number {
  let score = 0.5; // Score base

  // 1. Formato perfecto (+0.3)
  if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(plate)) score += 0.3; // Mercosur perfecto
  if (/^[A-Z]{3}\d{3}$/.test(plate)) score += 0.3; // Antiguo perfecto

  // 2. Posición en el texto (+0.2 si está al inicio)
  const position = fullText.indexOf(plate);
  if (position >= 0 && position < 50) score += 0.2;

  // 3. Frecuencia en detecciones individuales
  const individualMatches = detections.slice(1).filter((d) =>
    d.description && d.description.includes(plate)
  ).length;
  score += Math.min(individualMatches * 0.1, 0.3);

  // 4. Tamaño de la detección (asumiendo que patentes más grandes son más claras)
  // (Implementar si tienes bounding boxes)

  return Math.min(score, 1.0); // Máximo 1.0
}

/**
 * Determina el nivel de automatización sugerido basado en las patentes detectadas y su confianza.
 * @param {PlateDetection[]} plates - Un array de objetos PlateDetection ordenados por confianza.
 * @return {"high" | "medium" | "low" | "none"} El nivel de automatización ('high', 'medium', 'low', 'none').
 */
function determineAutomationLevel(plates: PlateDetection[]): "high" | "medium" | "low" | "none" {
  if (plates.length === 0) return "none";

  const bestPlate = plates[0];

  if (bestPlate.confidence >= 0.85 && plates.length === 1) {
    return "high"; // Automático
  }

  if (bestPlate.confidence >= 0.7 && plates.length <= 2) {
    return "medium"; // Confirmación rápida
  }

  return "low"; // Selección manual necesaria
}

/**
 * Sugiere una acción a tomar en la interfaz de usuario basada en el nivel de automatización.
 * @param {string} level - El nivel de automatización determinado.
 * @return {string} La acción sugerida ('auto_register', 'quick_confirm', 'manual_select', 'manual_input').
 */
function getSuggestedAction(level: string): string {
  switch (level) {
  case "high":
    return "auto_register";
  case "medium":
    return "quick_confirm";
  case "low":
    return "manual_select";
  default:
    return "manual_input";
  }
}

// Función de ejemplo para probar que la función está funcionando
export const testFunction = functions.https.onRequest((req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "3600");
    res.status(204).send("");
    return;
  }

  res.json({
    status: "ok",
    message: "La función detectLicensePlate está funcionando correctamente",
    endpoints: {
      detectLicensePlate: "POST /detectLicensePlate con { image: 'base64string' }",
    },
  });
});
