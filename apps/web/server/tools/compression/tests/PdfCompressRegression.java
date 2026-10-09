import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSInteger;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.graphics.image.JPEGFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationRubberStamp;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.PDSignature;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDSignatureField;

/** Synthetic PDFBox 3.0.5 regression; never reads business artwork or invokes native apps. */
public final class PdfCompressRegression {
    private static final COSName IMAGE = COSName.getPDFName("ImageA");
    private static final String DEFAULTS = "200,100000,32,32000000,134217728,1073741824";
    private static int checks;

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("supply a private fixture directory");
        Path dir = Path.of(args[0]);
        Files.createDirectories(dir);
        Path single = images(dir.resolve("single.pdf"), 1, true, false);
        Path shared = images(dir.resolve("shared-resources.pdf"), 4, true, false);
        Path aliases = images(dir.resolve("shared-image.pdf"), 4, false, false);
        Path distinct = images(dir.resolve("distinct-images.pdf"), 2, false, true);
        Path singleOut = dir.resolve("single-out.pdf");
        expectCode(0, "recompress", single.toString(), singleOut.toString(), "85");
        byte[] once = imageDigest(singleOut, false);
        for (Path input : new Path[] { shared, aliases }) {
            Path output = dir.resolve(input.getFileName().toString() + ".out.pdf");
            // One 32x16 decode is 2048 bytes: reused input and output identities
            // must neither re-encode nor consume a second decode reservation.
            expectCode(0, "recompress", input.toString(), output.toString(), "85",
                    "200,100000,32,32000000,134217728,2048");
            check(Arrays.equals(once, imageDigest(output, true)), "shared image is encoded exactly once");
        }
        Path rejected = dir.resolve("decode-rejected.pdf");
        expectCode(3, "recompress", distinct.toString(), rejected.toString(), "85",
                "200,100000,32,32000000,134217728,2048");
        check(!Files.exists(rejected), "cumulative decode overflow publishes no candidate");
        expectCode(3, "recompress", single.toString(), dir.resolve("pixel-rejected.pdf").toString(), "85",
                "200,100000,32,511,134217728,1073741824");
        expectCode(3, "recompress", single.toString(), dir.resolve("image-budget-rejected.pdf").toString(), "85",
                "200,100000,32,32000000,2047,1073741824");

        for (String context : new String[] { "independent", "UR", "UR3", "DocMDP", "unknown", "unknown-no-type", "malformed" }) {
            Path input = signature(dir.resolve(context + ".pdf"), context);
            Result inspected = run("inspect", input.toString());
            check(inspected.code == 0, "signature context remains inspectable: " + context);
            String expected = context.startsWith("unknown") || context.equals("malformed")
                    ? "\"signatureUnknown\":true" : "\"filledSignatures\":1";
            check(inspected.stdout.contains(expected), "signature context is protected: " + context);
            Path output = dir.resolve(context + ".out.pdf");
            expectCode(2, "recompress", input.toString(), output.toString(), "85");
            check(!Files.exists(output), "protected signature context is never rewritten: " + context);
        }
        for (String context : new String[] { "empty-field", "zero-field", "stamp" }) {
            Path input = signature(dir.resolve(context + ".pdf"), context);
            Result inspected = run("inspect", input.toString());
            check(inspected.code == 0 && inspected.stdout.contains("\"signatureUnknown\":false")
                    && inspected.stdout.contains("\"filledSignatures\":0"), "non-signature remains writable: " + context);
            if (!context.equals("stamp")) check(inspected.stdout.contains("\"emptySignatureFields\":1"), "empty field count");
            expectCode(0, "recompress", input.toString(), dir.resolve(context + ".out.pdf").toString(), "85");
        }

        expectCode(0, "inspect", single.toString(), DEFAULTS);
        expectCode(0, "boxes", single.toString(), DEFAULTS);
        expectCode(3, "boxes", shared.toString(), "1,100000,32,32000000,134217728,1073741824");
        expectCode(3, "inspect", single.toString(), "200,1,32,32000000,134217728,1073741824");
        for (String invalid : new String[] {
                "0,100000,32,32000000,134217728,1073741824", "-1,100000,32,32000000,134217728,1073741824",
                "201,100000,32,32000000,134217728,1073741824", "200,100001,32,32000000,134217728,1073741824",
                "200,100000,33,32000000,134217728,1073741824", "200,100000,32,32000001,134217728,1073741824",
                "200,100000,32,32000000,134217729,1073741824", "200,100000,32,32000000,134217728,1073741825",
                "200.0,100000,32,32000000,134217728,1073741824", "2e2,100000,32,32000000,134217728,1073741824",
                "200,100000,32,32000000,134217728", "200,100000,32,32000000,134217728,1073741824,1",
                "999999999999999999999,100000,32,32000000,134217728,1073741824", "200,100000,32,,134217728,1073741824" }) {
            expectCode(2, "inspect", single.toString(), invalid);
            expectCode(2, "boxes", single.toString(), invalid);
            expectCode(2, "recompress", single.toString(), dir.resolve("invalid.out.pdf").toString(), "85", invalid);
        }
        System.out.println("PDF_COMPRESS_SYNTHETIC_OK checks=" + checks);
    }

    private static Path images(Path path, int pages, boolean sharedResources, boolean distinctImages) throws IOException {
        try (PDDocument doc = new PDDocument()) {
            PDImageXObject common = JPEGFactory.createFromImage(doc, pixels(0), 1f);
            PDResources commonResources = new PDResources();
            commonResources.put(IMAGE, common);
            for (int index = 0; index < pages; index += 1) {
                PDPage page = new PDPage();
                PDResources resources = sharedResources ? commonResources : new PDResources();
                if (!sharedResources) resources.put(IMAGE, distinctImages ? JPEGFactory.createFromImage(doc, pixels(index), 1f) : common);
                page.setResources(resources);
                doc.addPage(page);
            }
            doc.save(path.toFile());
        }
        return path;
    }

    private static BufferedImage pixels(int seed) {
        BufferedImage image = new BufferedImage(32, 16, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < 16; y += 1) for (int x = 0; x < 32; x += 1) {
            image.setRGB(x, y, ((x * 31 + y * 7 + seed) & 255) << 16 | ((x * 3 + y * 29) & 255) << 8 | ((x * 19 + y * 11) & 255));
        }
        return image;
    }

    private static Path signature(Path path, String context) throws IOException {
        try (PDDocument doc = new PDDocument()) {
            PDPage page = new PDPage();
            doc.addPage(page);
            if (context.equals("empty-field") || context.equals("zero-field")) {
                PDAcroForm form = new PDAcroForm(doc);
                doc.getDocumentCatalog().setAcroForm(form);
                PDSignatureField field = new PDSignatureField(form);
                field.setPartialName("SyntheticEmpty");
                form.getFields().add(field);
                if (context.equals("zero-field")) {
                    PDSignature value = new PDSignature();
                    value.setContents(new byte[32]);
                    value.setByteRange(new int[] { 0, 0, 0, 0 });
                    field.setValue(value);
                }
            } else if (context.equals("stamp")) {
                page.getAnnotations().add(new PDAnnotationRubberStamp());
            } else {
                COSDictionary signature = new COSDictionary();
                signature.setItem(COSName.TYPE, COSName.SIG);
                signature.setItem(COSName.CONTENTS, new COSString(new byte[] { 1, 2, 3 }));
                COSArray range = new COSArray();
                for (int number : new int[] { 0, 1, 2, 1 }) range.add(COSInteger.get(number));
                if (!context.startsWith("unknown")) signature.setItem(COSName.BYTERANGE, range);
                if (context.equals("unknown-no-type")) {
                    signature.removeItem(COSName.TYPE);
                    signature.setItem(COSName.SUB_FILTER, COSName.getPDFName("adbe.pkcs7.detached"));
                }
                if (context.equals("malformed")) signature.setItem(COSName.BYTERANGE, COSInteger.ONE);
                if (context.equals("UR") || context.equals("UR3") || context.equals("DocMDP")) {
                    COSDictionary permissions = new COSDictionary();
                    permissions.setItem(context, signature);
                    doc.getDocumentCatalog().getCOSObject().setItem(COSName.PERMS, permissions);
                } else {
                    doc.getDocumentCatalog().getCOSObject().setItem("SyntheticSignature", signature);
                }
            }
            doc.save(path.toFile());
        }
        return path;
    }

    private static byte[] imageDigest(Path path, boolean requireShared) throws Exception {
        try (PDDocument doc = Loader.loadPDF(path.toFile())) {
            COSBase first = null;
            byte[] digest = null;
            for (PDPage page : doc.getPages()) {
                PDImageXObject image = (PDImageXObject) page.getResources().getXObject(IMAGE);
                byte[] current;
                try (var stream = image.getCOSObject().createRawInputStream()) {
                    current = MessageDigest.getInstance("SHA-256").digest(stream.readAllBytes());
                }
                if (first == null) { first = image.getCOSObject(); digest = current; }
                else {
                    check(Arrays.equals(digest, current), "all pages share identical encoded image bytes");
                    if (requireShared) check(first == image.getCOSObject(), "all image references share the same cached object");
                }
            }
            return digest;
        }
    }

    private static Result run(String... args) throws Exception {
        List<String> command = new ArrayList<String>();
        command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
        command.add("-Xmx256m");
        command.add("-cp");
        command.add(System.getProperty("java.class.path"));
        command.add("PdfCompress");
        command.addAll(Arrays.asList(args));
        Process child = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        String stdout = new String(child.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        return new Result(child.waitFor(), stdout);
    }

    private static void expectCode(int code, String... args) throws Exception {
        Result result = run(args);
        check(result.code == code, "exit code " + code + " for " + Arrays.toString(args) + "; got " + result.code);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks += 1;
    }

    private record Result(int code, String stdout) { }
}
