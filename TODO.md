# LangCanvas — TODO

## 0. Guardar grafos (logueado)

Listo: biblioteca de diseños (abrir / borrar / nuevo) + autosave de borradores en Firestore (`users/{uid}/graphs`).

---

## 1. Editor de propiedades al doble clic

Cuando das doble clic sobre un elemento, el cuadro para rellenar las propiedades se abre muy abajo y no se ve. Para completarlo hay que hacer scrolling.

Hay que mejorarlo: ponerlo más arriba o en otro lado.

**No ponerlo a la derecha.**

## 2. Auto-scroll al arrastrar

Cuando tomás un elemento del grafo y lo arrastrás hacia abajo, la pantalla debería hacer scrolling automático acompañando el movimiento.

## 3. Propiedades genéricas (no solo Reflexion)

Algunas propiedades de los elementos sienten diseñadas específicamente para el Reflexion agent, y no está claro si son genéricas para cualquier arquitectura.

Los elementos tienen que ser lo más **genéricos** posible.

## 4. Cuadro de ejecución

El cuadro de ejecución no hace nada. Evaluar qué fin le podemos dar.

## 5. Asistente a la derecha

Evaluar incluir un asistente a la derecha al que le puedas ir haciendo preguntas acerca de cómo armar bien completo tu sistema.

## 6. Tutoriales (además de templates)

Además de templates, incluir tutoriales de cómo usar la plataforma paso a paso construyendo grafos.

## 7. Validate

Verificar que la función **validate** esté validando bien con las nuevas implementaciones.

## 8. Analyze AI

Verificar **analyze AI**.

## 9. Generate code

Verificar que **generate code** genere bien el código con las nuevas modificaciones.

## 10. Step forward vs. visibilidad del grafo

Cuando estás ejecutando, el cuadro de marcha (**step forward**) queda muy abajo en la pantalla. Para usarlo dejás de ver el grafo porque te quedó muy arriba.

Es poco práctico: ves una pantalla vacía mientras corrés la marcha. Hay que poder **step forward** sin perder de vista el grafo.

## 11. Historial de marcha estilo LangSmith

Respecto al cuadro de marcha: cuando vas ejecutando y ves el historial, no debería ser un log de pasos genérico.

Debería parecerse más a **LangSmith**: ir viendo cómo avanza el **state**, qué **entra** en cada nodo, qué **entrega** cada nodo, qué responde cada **LLM**, y qué devuelve cada **función o tool**.
