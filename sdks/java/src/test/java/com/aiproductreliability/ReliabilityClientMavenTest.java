package com.aiproductreliability;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class ReliabilityClientMavenTest {
    @Test
    void runsTheSharedBehaviorAndProtocolContract() throws Exception {
        Path repositoryRoot = Path.of(System.getProperty("repositoryRoot")).toAbsolutePath().normalize();
        ReliabilityClientContractTest.main(new String[] { repositoryRoot.toString() });
    }
}
