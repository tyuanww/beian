import java.io.File;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Set;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSInteger;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSObject;
import org.apache.pdfbox.cos.COSObjectKey;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.io.RandomAccessReadBufferedFile;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.PDXObject;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.image.JPEGFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.PDSignature;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;
import org.apache.pdfbox.pdmodel.interactive.form.PDSignatureField;

/**
 * 小型 PDFBox 3.0.5 helper。不渲染整页，不灰度，不拆页，不删页。
 * 只把无蒙版的 DeviceRGB DCT 图片按给定质量重压，其它对象原样保留。
 * 退出码：0 完成，2 内容不能安全重写，3 超出页数/对象/像素预算，4 过滤器不能安全解码。
 */
public final class PdfCompress {
    private static final int MAX_PAGES = 200;
    private static final int MAX_OBJECTS = 100_000;
    private static final int MAX_FORM_DEPTH = 32;
    private static final long MAX_PIXELS = 32_000_000L;
    private static final long MAX_DECODE_BYTES = 128L * 1024L * 1024L;
    private static final long MAX_DECODE_STREAM_BYTES = 1024L * 1024L * 1024L;

    private PdfCompress() {
    }

    public static void main(String[] args) {
        int code = 2;
        try {
            code = run(args);
        } catch (ResourceLimit ex) {
            System.err.println("pdfbox=resource");
            code = 3;
        } catch (FilterUnsupported ex) {
            System.err.println("pdfbox=filter");
            code = 4;
        } catch (Exception ex) {
            System.err.println("pdfbox=corrupt");
            code = 2;
        }
        System.exit(code);
    }

    private static int run(String[] args) throws IOException {
        if (args.length < 2) {
            return 2;
        }
        String mode = args[0];
        int requiredArgs = "recompress".equals(mode) ? 4 : 2;
        if (args.length != requiredArgs && args.length != requiredArgs + 1) {
            return 2;
        }
        Limits limits = args.length == requiredArgs ? new Limits() : Limits.parse(args[requiredArgs]);
        File input = new File(args[1]);
        if (!input.isFile()) {
            return 2;
        }
        if ("inspect".equals(mode)) {
            System.out.println(inspect(input, limits));
            return 0;
        }
        if ("boxes".equals(mode)) {
            System.out.println(boxes(input, limits));
            return 0;
        }
        if ("recompress".equals(mode)) {
            int quality = Integer.parseInt(args[3]);
            if (quality < 60 || quality > 95) {
                return 2;
            }
            return recompress(input, new File(args[2]), quality / 100f, limits);
        }
        return 2;
    }

    private static String inspect(File input, Limits limits) throws IOException {
        try (PDDocument doc = open(input)) {
            guardStructure(doc, limits);
            Report report = signatureReport(doc, input.length(), limits);
            for (PDPage page : doc.getPages()) {
                try {
                    for (PDAnnotation annotation : page.getAnnotations()) {
                        if ("Stamp".equals(annotation.getSubtype())) {
                            report.stamps += 1;
                        }
                    }
                } catch (IOException ex) {
                    report.unknown = true;
                }
                report.formDepth = Math.max(report.formDepth, formDepth(page.getResources(), new HashSet<COSBase>(), 0, limits));
            }
            return "{\"readable\":true,\"pages\":" + doc.getNumberOfPages()
                    + ",\"objects\":" + doc.getDocument().getXrefTable().size()
                    + ",\"formDepth\":" + report.formDepth
                    + ",\"filledSignatures\":" + report.filledSignatures
                    + ",\"emptySignatureFields\":" + report.emptySignatures
                    + ",\"docMdp\":" + report.docMdp
                    + ",\"signatureUnknown\":" + report.unknown
                    + ",\"stampAnnotations\":" + report.stamps
                    + ",\"incremental\":" + report.incremental + "}";
        }
    }

    private static String boxes(File input, Limits limits) throws IOException {
        try (PDDocument doc = open(input)) {
            guardStructure(doc, limits);
            return "{\"pages\":" + doc.getNumberOfPages() + ",\"boxes\":\"" + boxText(doc) + "\"}";
        }
    }

    private static int recompress(File input, File output, float quality, Limits limits) throws IOException {
        String before;
        try (PDDocument doc = open(input)) {
            guardStructure(doc, limits);
            Report signatures = signatureReport(doc, input.length(), limits);
            if (signatures.docMdp || signatures.incremental || signatures.unknown || signatures.filledSignatures > 0) {
                System.err.println("pdfbox=refused");
                return 2;
            }
            before = boxText(doc);
            RecompressionState state = new RecompressionState(limits);
            for (PDPage page : doc.getPages()) {
                recompressResources(doc, page.getResources(), quality, new HashSet<COSBase>(), 0, state);
            }
            if (!before.equals(boxText(doc)) || doc.getNumberOfPages() < 1) {
                System.err.println("pdfbox=refused");
                return 2;
            }
            doc.save(output);
        }
        try (PDDocument saved = open(output)) {
            guardStructure(saved, limits);
            if (!before.equals(boxText(saved))) {
                output.delete();
                System.err.println("pdfbox=refused");
                return 2;
            }
        }
        System.err.println("pdfbox=ok");
        return 0;
    }

    private static PDDocument open(File input) throws IOException {
        return Loader.loadPDF(new RandomAccessReadBufferedFile(input));
    }

    private static void guardStructure(PDDocument doc, Limits limits) {
        int pages = doc.getNumberOfPages();
        int objects = doc.getDocument().getXrefTable().size();
        if (pages < 1 || pages > limits.pages || objects > limits.objects) {
            throw new ResourceLimit();
        }
    }

    private static Report signatureReport(PDDocument doc, long inputBytes, Limits limits) throws IOException {
        Report report = new Report();
        Set<COSBase> classified = Collections.newSetFromMap(new IdentityHashMap<COSBase, Boolean>());
        COSDictionary catalog = doc.getDocumentCatalog().getCOSObject();
        COSBase perms = catalog.getDictionaryObject(COSName.PERMS);
        if (perms instanceof COSDictionary) {
            COSDictionary permissions = (COSDictionary) perms;
            report.docMdp = permissions.containsKey("DocMDP");
            for (String key : new String[] { "DocMDP", "UR", "UR3" }) {
                if (!permissions.containsKey(key)) continue;
                COSBase value = permissions.getDictionaryObject(key);
                if (!(value instanceof COSDictionary)) report.unknown = true;
                else classifySignature((COSDictionary) value, false, inputBytes, report, classified);
            }
        } else if (catalog.containsKey(COSName.PERMS)) {
            report.unknown = true;
        }
        COSDictionary trailer = doc.getDocument().getTrailer();
        report.incremental = trailer != null && trailer.getDictionaryObject(COSName.PREV) != null;
        report.unknown |= report.incremental;
        try {
            PDAcroForm form = doc.getDocumentCatalog().getAcroForm();
            if (form != null) {
                for (PDField field : form.getFieldTree()) {
                    if (!(field instanceof PDSignatureField)) continue;
                    PDSignature signature = ((PDSignatureField) field).getSignature();
                    if (signature == null) report.emptySignatures += 1;
                    else classifySignature(signature.getCOSObject(), true, inputBytes, report, classified);
                }
            }
        } catch (RuntimeException ex) {
            report.unknown = true;
        }
        // Traverse dictionaries, never stream contents. AcroForm is not the only
        // signature entry point; include independent and lazily parsed objects.
        ArrayDeque<COSBase> pending = new ArrayDeque<COSBase>();
        if (trailer != null) pending.add(trailer);
        for (COSObjectKey key : new ArrayList<COSObjectKey>(doc.getDocument().getXrefTable().keySet())) {
            pending.add(doc.getDocument().getObjectFromPool(key));
        }
        Set<COSBase> visited = Collections.newSetFromMap(new IdentityHashMap<COSBase, Boolean>());
        int containers = 0;
        while (!pending.isEmpty()) {
            COSBase value = pending.removeLast();
            if (!visited.add(value)) continue;
            if (value instanceof COSObject) {
                COSBase resolved = ((COSObject) value).getObject();
                if (resolved != null) pending.add(resolved);
                else report.unknown = true;
            } else if (value instanceof COSDictionary) {
                if (++containers > limits.objects) throw new ResourceLimit();
                COSDictionary dictionary = (COSDictionary) value;
                COSBase type = dictionary.getDictionaryObject(COSName.TYPE);
                if (COSName.SIG.equals(type) || COSName.getPDFName("DocTimeStamp").equals(type)
                        || dictionary.containsKey(COSName.BYTERANGE)
                        || dictionary.containsKey(COSName.CONTENTS) && dictionary.containsKey(COSName.SUB_FILTER)) {
                    classifySignature(dictionary, false, inputBytes, report, classified);
                }
                for (COSBase child : dictionary.getValues()) if (child != null) pending.add(child);
            } else if (value instanceof COSArray) {
                if (++containers > limits.objects) throw new ResourceLimit();
                for (COSBase child : (COSArray) value) if (child != null) pending.add(child);
            }
            if (pending.size() > limits.objects * 8L) throw new ResourceLimit();
        }
        guardStructure(doc, limits);
        return report;
    }

    private static void classifySignature(COSDictionary signature, boolean emptyFieldAllowed, long inputBytes,
            Report report, Set<COSBase> classified) {
        if (!classified.add(signature)) return;
        COSBase contents = signature.getDictionaryObject(COSName.CONTENTS);
        COSBase range = signature.getDictionaryObject(COSName.BYTERANGE);
        if (emptyFieldAllowed && (contents == null || contents instanceof COSString && allZero(((COSString) contents).getBytes()))
                && (range == null || emptyByteRange(range))) {
            report.emptySignatures += 1;
        } else if (contents instanceof COSString && !allZero(((COSString) contents).getBytes())
                && validByteRange(range, inputBytes)) {
            report.filledSignatures += 1;
        } else {
            report.unknown = true;
        }
    }

    private static boolean emptyByteRange(COSBase value) {
        if (!(value instanceof COSArray) || ((COSArray) value).size() != 4) return false;
        for (COSBase item : (COSArray) value) {
            if (!(item instanceof COSInteger) || ((COSInteger) item).longValue() != 0) return false;
        }
        return true;
    }

    private static boolean validByteRange(COSBase value, long inputBytes) {
        if (!(value instanceof COSArray)) return false;
        COSArray range = (COSArray) value;
        if (range.size() < 4 || range.size() % 2 != 0) return false;
        long end = 0;
        for (int index = 0; index < range.size(); index += 2) {
            COSBase offsetValue = range.getObject(index);
            COSBase lengthValue = range.getObject(index + 1);
            if (!(offsetValue instanceof COSInteger) || !(lengthValue instanceof COSInteger)) return false;
            long offset = ((COSInteger) offsetValue).longValue();
            long length = ((COSInteger) lengthValue).longValue();
            if (offset < end || length < 0 || offset > inputBytes || length > inputBytes - offset
                    || index == 0 && offset != 0) return false;
            end = offset + length;
        }
        return end > 0;
    }

    private static void recompressResources(PDDocument doc, PDResources resources, float quality, Set<COSBase> seen,
            int depth, RecompressionState state) throws IOException {
        if (resources == null) {
            return;
        }
        if (depth > state.limits.formDepth) {
            throw new ResourceLimit();
        }
        for (COSName name : resources.getXObjectNames()) {
            PDXObject xobject = resources.getXObject(name);
            COSBase identity = xobject.getCOSObject();
            PDImageXObject cached = state.images.get(identity);
            if (cached != null) {
                resources.put(name, cached);
                continue;
            }
            if (!seen.add(identity)) {
                continue;
            }
            if (xobject instanceof PDFormXObject) {
                recompressResources(doc, ((PDFormXObject) xobject).getResources(), quality, seen, depth + 1, state);
                continue;
            }
            if (!(xobject instanceof PDImageXObject)) {
                continue;
            }
            PDImageXObject image = (PDImageXObject) xobject;
            state.images.put(identity, image);
            COSDictionary dictionary = image.getCOSObject();
            if (dictionary.getDictionaryObject(COSName.SMASK) != null
                    || dictionary.getDictionaryObject(COSName.MASK) != null
                    || !deviceRgbDct(dictionary)) {
                continue;
            }
            long pixels = (long) image.getWidth() * (long) image.getHeight();
            if (pixels <= 0 || pixels > state.limits.imagePixels || pixels * 4L > state.limits.imageDecodeBytes) {
                throw new ResourceLimit();
            }
            long decodeBytes = pixels * 4L;
            if (decodeBytes > state.limits.decodeStreamBytes - state.decodedBytes) throw new ResourceLimit();
            state.decodedBytes += decodeBytes;
            try {
                java.awt.image.BufferedImage decoded = image.getImage();
                if (decoded == null || decoded.getColorModel().hasAlpha()) {
                    continue;
                }
                PDImageXObject encoded = JPEGFactory.createFromImage(doc, decoded, quality);
                // The new identity can be observed on the next page when its
                // Resources dictionary is shared. Neither identity may re-encode.
                state.images.put(identity, encoded);
                state.images.put(encoded.getCOSObject(), encoded);
                resources.put(name, encoded);
            } catch (IOException ex) {
                throw new FilterUnsupported();
            }
        }
    }

    private static boolean deviceRgbDct(COSDictionary dictionary) {
        return COSName.DEVICERGB.equals(dictionary.getDictionaryObject(COSName.COLORSPACE)) && dctOnly(
                dictionary.getDictionaryObject(COSName.FILTER));
    }

    private static boolean dctOnly(COSBase filter) {
        if (COSName.DCT_DECODE.equals(filter)) {
            return true;
        }
        if (filter instanceof COSArray && ((COSArray) filter).size() == 1) {
            return COSName.DCT_DECODE.equals(((COSArray) filter).getObject(0));
        }
        return false;
    }

    private static int formDepth(PDResources resources, Set<COSBase> seen, int depth, Limits limits) throws IOException {
        if (resources == null) {
            return depth;
        }
        if (depth > limits.formDepth) {
            throw new ResourceLimit();
        }
        int max = depth;
        for (COSName name : resources.getXObjectNames()) {
            PDXObject xobject = resources.getXObject(name);
            if (!(xobject instanceof PDFormXObject) || !seen.add(xobject.getCOSObject())) {
                continue;
            }
            max = Math.max(max, formDepth(((PDFormXObject) xobject).getResources(), seen, depth + 1, limits));
        }
        return max;
    }

    private static String boxText(PDDocument doc) {
        StringBuilder text = new StringBuilder();
        for (PDPage page : doc.getPages()) {
            PDRectangle box = page.getMediaBox();
            text.append(box.getLowerLeftX()).append(',').append(box.getLowerLeftY()).append(',')
                    .append(box.getWidth()).append(',').append(box.getHeight()).append(';');
        }
        return text.toString();
    }

    private static boolean allZero(byte[] contents) {
        if (contents.length == 0) {
            return true;
        }
        for (byte value : contents) {
            if (value != 0) {
                return false;
            }
        }
        return true;
    }

    private static final class Report {
        int filledSignatures;
        int emptySignatures;
        int stamps;
        int formDepth;
        boolean docMdp;
        boolean unknown;
        boolean incremental;
    }

    private static final class RecompressionState {
        final Limits limits;
        final Map<COSBase, PDImageXObject> images = new IdentityHashMap<COSBase, PDImageXObject>();
        long decodedBytes;

        RecompressionState(Limits limits) { this.limits = limits; }
    }

    /** Optional last argv: pages,objects,formDepth,imagePixels,imageDecodeBytes,decodeStreamBytes. */
    private static final class Limits {
        int pages = MAX_PAGES;
        int objects = MAX_OBJECTS;
        int formDepth = MAX_FORM_DEPTH;
        long imagePixels = MAX_PIXELS;
        long imageDecodeBytes = MAX_DECODE_BYTES;
        long decodeStreamBytes = MAX_DECODE_STREAM_BYTES;

        static Limits parse(String text) {
            String[] parts = text.split(",", -1);
            long[] hard = { MAX_PAGES, MAX_OBJECTS, MAX_FORM_DEPTH, MAX_PIXELS, MAX_DECODE_BYTES, MAX_DECODE_STREAM_BYTES };
            if (parts.length != hard.length || text.length() > 128) throw new IllegalArgumentException("limits");
            long[] values = new long[hard.length];
            for (int index = 0; index < parts.length; index += 1) {
                if (!parts[index].matches("[1-9][0-9]*")) throw new IllegalArgumentException("limits");
                values[index] = Long.parseLong(parts[index]);
                if (values[index] > hard[index]) throw new IllegalArgumentException("limits");
            }
            Limits limits = new Limits();
            limits.pages = (int) values[0];
            limits.objects = (int) values[1];
            limits.formDepth = (int) values[2];
            limits.imagePixels = values[3];
            limits.imageDecodeBytes = values[4];
            limits.decodeStreamBytes = values[5];
            return limits;
        }
    }

    private static final class ResourceLimit extends RuntimeException {
    }

    private static final class FilterUnsupported extends RuntimeException {
    }
}
