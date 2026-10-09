import java.io.File;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
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
        File input = new File(args[1]);
        if (!input.isFile()) {
            return 2;
        }
        if ("inspect".equals(mode)) {
            System.out.println(inspect(input));
            return 0;
        }
        if ("boxes".equals(mode)) {
            System.out.println(boxes(input));
            return 0;
        }
        if ("recompress".equals(mode) && args.length == 4) {
            int quality = Integer.parseInt(args[3]);
            if (quality < 60 || quality > 95) {
                return 2;
            }
            return recompress(input, new File(args[2]), quality / 100f);
        }
        return 2;
    }

    private static String inspect(File input) throws IOException {
        try (PDDocument doc = open(input)) {
            guardStructure(doc);
            Report report = new Report();
            COSDictionary trailer = doc.getDocument().getTrailer();
            report.incremental = trailer != null && trailer.getDictionaryObject(COSName.PREV) != null;
            COSDictionary catalog = doc.getDocumentCatalog().getCOSObject();
            COSBase perms = catalog.getDictionaryObject(COSName.PERMS);
            if (perms instanceof COSDictionary) {
                report.docMdp = ((COSDictionary) perms).getDictionaryObject(COSName.getPDFName("DocMDP")) != null;
            }
            try {
                PDAcroForm form = doc.getDocumentCatalog().getAcroForm();
                if (form != null) {
                    for (PDField field : form.getFieldTree()) {
                        if (!(field instanceof PDSignatureField)) {
                            continue;
                        }
                        PDSignature signature = ((PDSignatureField) field).getSignature();
                        if (signature == null || signature.getContents() == null || signature.getByteRange() == null
                                || allZero(signature.getContents())) {
                            report.emptySignatures += 1;
                        } else {
                            report.filledSignatures += 1;
                        }
                    }
                }
            } catch (IOException ex) {
                report.unknown = true;
            }
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
                report.formDepth = Math.max(report.formDepth, formDepth(page.getResources(), new HashSet<COSBase>(), 0));
            }
            if (report.incremental) {
                report.unknown = true;
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

    private static String boxes(File input) throws IOException {
        try (PDDocument doc = open(input)) {
            guardStructure(doc);
            return "{\"pages\":" + doc.getNumberOfPages() + ",\"boxes\":\"" + boxText(doc) + "\"}";
        }
    }

    private static int recompress(File input, File output, float quality) throws IOException {
        String before;
        try (PDDocument doc = open(input)) {
            guardStructure(doc);
            if (signedOrRestricted(doc)) {
                System.err.println("pdfbox=refused");
                return 2;
            }
            before = boxText(doc);
            for (PDPage page : doc.getPages()) {
                recompressResources(doc, page.getResources(), quality, new HashSet<COSBase>(), 0);
            }
            if (!before.equals(boxText(doc)) || doc.getNumberOfPages() < 1) {
                System.err.println("pdfbox=refused");
                return 2;
            }
            doc.save(output);
        }
        try (PDDocument saved = open(output)) {
            guardStructure(saved);
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

    private static void guardStructure(PDDocument doc) {
        int pages = doc.getNumberOfPages();
        int objects = doc.getDocument().getXrefTable().size();
        if (pages < 1 || pages > MAX_PAGES || objects > MAX_OBJECTS) {
            throw new ResourceLimit();
        }
    }

    private static boolean signedOrRestricted(PDDocument doc) throws IOException {
        COSDictionary catalog = doc.getDocumentCatalog().getCOSObject();
        COSBase perms = catalog.getDictionaryObject(COSName.PERMS);
        if (perms instanceof COSDictionary
                && ((COSDictionary) perms).getDictionaryObject(COSName.getPDFName("DocMDP")) != null) {
            return true;
        }
        COSDictionary trailer = doc.getDocument().getTrailer();
        if (trailer != null && trailer.getDictionaryObject(COSName.PREV) != null) {
            return true;
        }
        PDAcroForm form = doc.getDocumentCatalog().getAcroForm();
        if (form == null) {
            return false;
        }
        for (PDField field : form.getFieldTree()) {
            if (field instanceof PDSignatureField && ((PDSignatureField) field).getSignature() != null) {
                PDSignature signature = ((PDSignatureField) field).getSignature();
                if (signature.getContents() != null && !allZero(signature.getContents())) {
                    return true;
                }
            }
        }
        return false;
    }

    private static void recompressResources(PDDocument doc, PDResources resources, float quality, Set<COSBase> seen,
            int depth) throws IOException {
        if (resources == null) {
            return;
        }
        if (depth > MAX_FORM_DEPTH) {
            throw new ResourceLimit();
        }
        for (COSName name : resources.getXObjectNames()) {
            PDXObject xobject = resources.getXObject(name);
            COSBase identity = xobject.getCOSObject();
            if (!seen.add(identity)) {
                continue;
            }
            if (xobject instanceof PDFormXObject) {
                recompressResources(doc, ((PDFormXObject) xobject).getResources(), quality, seen, depth + 1);
                continue;
            }
            if (!(xobject instanceof PDImageXObject)) {
                continue;
            }
            PDImageXObject image = (PDImageXObject) xobject;
            COSDictionary dictionary = image.getCOSObject();
            if (dictionary.getDictionaryObject(COSName.SMASK) != null
                    || dictionary.getDictionaryObject(COSName.MASK) != null
                    || !deviceRgbDct(dictionary)) {
                continue;
            }
            long pixels = (long) image.getWidth() * (long) image.getHeight();
            if (pixels <= 0 || pixels > MAX_PIXELS || pixels * 4L > MAX_DECODE_BYTES) {
                throw new ResourceLimit();
            }
            try {
                java.awt.image.BufferedImage decoded = image.getImage();
                if (decoded == null || decoded.getColorModel().hasAlpha()) {
                    continue;
                }
                PDImageXObject encoded = JPEGFactory.createFromImage(doc, decoded, quality);
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

    private static int formDepth(PDResources resources, Set<COSBase> seen, int depth) throws IOException {
        if (resources == null) {
            return depth;
        }
        if (depth > MAX_FORM_DEPTH) {
            throw new ResourceLimit();
        }
        int max = depth;
        for (COSName name : resources.getXObjectNames()) {
            PDXObject xobject = resources.getXObject(name);
            if (!(xobject instanceof PDFormXObject) || !seen.add(xobject.getCOSObject())) {
                continue;
            }
            max = Math.max(max, formDepth(((PDFormXObject) xobject).getResources(), seen, depth + 1));
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

    private static final class ResourceLimit extends RuntimeException {
    }

    private static final class FilterUnsupported extends RuntimeException {
    }
}
