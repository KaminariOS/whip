import com.android.build.api.instrumentation.AsmClassVisitorFactory
import com.android.build.api.instrumentation.ClassContext
import com.android.build.api.instrumentation.ClassData
import com.android.build.api.instrumentation.FramesComputationMode
import com.android.build.api.instrumentation.InstrumentationParameters
import com.android.build.api.instrumentation.InstrumentationScope
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.MethodVisitor
import org.objectweb.asm.Opcodes

/*
 * React Native 0.86 can emit a remove mutation whose parent tag resolves to a
 * non-ViewGroup, crashing Android in SurfaceMountingManager.removeViewAt.
 *
 * Issue: https://github.com/react/react-native/issues/57800
 * Upstream fix: https://github.com/react/react-native/pull/57860
 *
 * React Native is consumed as a prebuilt AAR, so this applies the upstream
 * soft-failure behavior to the dependency bytecode until that fix is released.
 */
class ReactNativeFabricCrashMitigationPlugin implements Plugin<Project> {
    @Override
    void apply(Project project) {
        project.pluginManager.withPlugin('com.android.application') {
            def androidComponents = project.extensions.getByType(
                ApplicationAndroidComponentsExtension
            )
            androidComponents.onVariants(androidComponents.selector().all()) { variant ->
                variant.instrumentation.transformClassesWith(
                    ReactNativeFabricCrashMitigationFactory,
                    InstrumentationScope.ALL
                ) { }
                variant.instrumentation.setAsmFramesComputationMode(
                    FramesComputationMode.COPY_FRAMES
                )
            }
        }
    }
}

abstract class ReactNativeFabricCrashMitigationFactory
    implements AsmClassVisitorFactory<InstrumentationParameters.None> {
    private static final String TARGET_CLASS =
        'com.facebook.react.fabric.mounting.SurfaceMountingManager'

    @Override
    ClassVisitor createClassVisitor(
        ClassContext classContext,
        ClassVisitor nextClassVisitor
    ) {
        return new SurfaceMountingManagerClassVisitor(nextClassVisitor)
    }

    @Override
    boolean isInstrumentable(ClassData classData) {
        return classData.className == TARGET_CLASS
    }
}

class SurfaceMountingManagerClassVisitor extends ClassVisitor {
    private static final String TARGET_METHOD = 'removeViewAt'
    private static final String TARGET_DESCRIPTOR = '(III)V'

    private boolean targetMethodFound = false
    private boolean mitigationApplied = false

    SurfaceMountingManagerClassVisitor(ClassVisitor nextClassVisitor) {
        super(Opcodes.ASM9, nextClassVisitor)
    }

    @Override
    MethodVisitor visitMethod(
        int access,
        String name,
        String descriptor,
        String signature,
        String[] exceptions
    ) {
        def nextMethodVisitor = super.visitMethod(
            access,
            name,
            descriptor,
            signature,
            exceptions
        )
        if (name != TARGET_METHOD || descriptor != TARGET_DESCRIPTOR) {
            return nextMethodVisitor
        }

        targetMethodFound = true
        return new RemoveViewAtMethodVisitor(nextMethodVisitor, this)
    }

    void markMitigationApplied() {
        mitigationApplied = true
    }

    @Override
    void visitEnd() {
        if (!targetMethodFound || !mitigationApplied) {
            throw new GradleException(
                'React Native Fabric crash mitigation no longer matches ' +
                    'SurfaceMountingManager.removeViewAt; review issue #57800 ' +
                    'and upstream PR #57860 before building.'
            )
        }
        super.visitEnd()
    }
}

class RemoveViewAtMethodVisitor extends MethodVisitor {
    private static final String VIEW_GROUP = 'android/view/ViewGroup'
    private static final String SOFT_EXCEPTION_LOGGER =
        'com/facebook/react/bridge/ReactSoftExceptionLogger'
    private static final String SOFT_EXCEPTION_CATEGORY =
        'SurfaceMountingManager'

    private final SurfaceMountingManagerClassVisitor owner
    private boolean pendingNonViewGroupThrow = false

    RemoveViewAtMethodVisitor(
        MethodVisitor nextMethodVisitor,
        SurfaceMountingManagerClassVisitor owner
    ) {
        super(Opcodes.ASM9, nextMethodVisitor)
        this.owner = owner
    }

    @Override
    void visitTypeInsn(int opcode, String type) {
        if (opcode == Opcodes.INSTANCEOF && type == VIEW_GROUP) {
            pendingNonViewGroupThrow = true
        }
        super.visitTypeInsn(opcode, type)
    }

    @Override
    void visitInsn(int opcode) {
        if (opcode == Opcodes.ATHROW && pendingNonViewGroupThrow) {
            // The IllegalStateException is already on the stack. Report it as
            // a React Native soft exception and treat the impossible removal
            // as the semantic no-op used by upstream PR #57860.
            super.visitLdcInsn(SOFT_EXCEPTION_CATEGORY)
            super.visitInsn(Opcodes.SWAP)
            super.visitMethodInsn(
                Opcodes.INVOKESTATIC,
                SOFT_EXCEPTION_LOGGER,
                'logSoftException',
                '(Ljava/lang/String;Ljava/lang/Throwable;)V',
                false
            )
            super.visitInsn(Opcodes.RETURN)
            pendingNonViewGroupThrow = false
            owner.markMitigationApplied()
            return
        }
        super.visitInsn(opcode)
    }
}
